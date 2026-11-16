import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export const TEMPLATE_NAMES = ["typescript", "python"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

export class TemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

export function isTemplateName(value: unknown): value is TemplateName {
  return value === "typescript" || value === "python";
}

/** Portable file names only; no traversal, Git internals or secret files. */
export function safeTemplateFilePath(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._/-]+$/.test(value))
    return false;
  const parts = value.toLowerCase().split("/");
  return parts.every(
    (part) =>
      part !== "" &&
      part !== "." &&
      part !== ".." &&
      part !== ".git" &&
      part !== "node_modules" &&
      (!/^\.env(?:\.|$)/.test(part) || part === ".env.example"),
  );
}

export type TemplateFile = {
  path: string;
  mode: number;
  bytes: Buffer;
  sha256: string;
};
export type Template = {
  name: TemplateName;
  provenance: {
    repository: string;
    commit: string;
    ref: string | null;
    published: boolean;
  };
  files: TemplateFile[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const corrupt = () =>
  new TemplateError(
    "template_corrupt",
    "The bundled template failed its integrity check. Reinstall the CLI or rebuild this source checkout.",
  );

/** Shared by the builder and runtime: verify every byte before writing any file. */
export function decodeTemplate(value: unknown, name: TemplateName): Template {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.name !== name ||
    !record(value.provenance) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 200
  )
    throw corrupt();
  const source = value.provenance;
  if (
    source.repository !== `blueskydotbot/bot-template-${name}` ||
    typeof source.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(source.commit) ||
    typeof source.published !== "boolean" ||
    !(
      source.ref === null ||
      (typeof source.ref === "string" &&
        /^refs\/tags\/v[0-9A-Za-z._-]+$/.test(source.ref))
    ) ||
    (source.published && source.ref === null)
  )
    throw corrupt();
  const names = new Set<string>();
  let total = 0;
  const files = value.files.map((entry): TemplateFile => {
    if (
      !record(entry) ||
      !safeTemplateFilePath(entry.path) ||
      (entry.mode !== 0o644 && entry.mode !== 0o755) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.content !== "string" ||
      entry.content.length > 2 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        entry.content,
      )
    )
      throw corrupt();
    const lower = entry.path.toLowerCase();
    if (
      names.has(lower) ||
      [...names].some(
        (other) =>
          other.startsWith(`${lower}/`) || lower.startsWith(`${other}/`),
      )
    )
      throw corrupt();
    names.add(lower);
    const bytes = Buffer.from(entry.content, "base64");
    total += bytes.byteLength;
    if (
      bytes.byteLength > 1024 * 1024 ||
      total > MAX_TEMPLATE_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw corrupt();
    return { path: entry.path, mode: entry.mode, bytes, sha256: entry.sha256 };
  });
  for (const required of [
    ".env.example",
    ".gitignore",
    "bluesky-bot.json",
    "README.md",
    "LICENSE",
    name === "typescript" ? "package.json" : "requirements.txt",
  ]) {
    if (!files.some((file) => file.path === required)) throw corrupt();
  }
  return {
    name,
    provenance: {
      repository: source.repository,
      commit: source.commit,
      ref: source.ref,
      published: source.published,
    },
    files,
  };
}

export async function loadTemplate(name: TemplateName): Promise<Template> {
  try {
    // The same package-relative location from src/ and the compiled dist/.
    const file = new URL(`../dist/templates/${name}.json`, import.meta.url);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_TEMPLATE_BYTES * 2
    )
      throw corrupt();
    return decodeTemplate(JSON.parse(await readFile(file, "utf8")), name);
  } catch (error) {
    if (error instanceof TemplateError) throw error;
    throw new TemplateError(
      "template_unavailable",
      "Bundled templates are unavailable. Rebuild this source checkout or reinstall the CLI.",
    );
  }
}
