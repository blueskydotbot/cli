import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { BotListing } from "./api.ts";
import { UsageError } from "./errors.ts";
import {
  isTemplateName,
  loadTemplate,
  type TemplateName,
  TemplateError,
} from "./templates.ts";

const execute = promisify(execFile);
const DEFAULT_DIRECTORY = "my-bluesky-bot";

export type InitFlags = {
  template?: string;
  bot?: string;
  "no-git"?: boolean;
  yes?: boolean;
};
export type OmittedField =
  | "disclosure.contact"
  | "disclosure.contactEmailPublic"
  | "operator.name";
export type InitResult = {
  dir: string;
  template: TemplateName;
  files: string[];
  development: boolean;
  omitted: OmittedField[];
};
export type BotPrefill = { identifier: string; listing?: BotListing };

/** Platform display consent never grants consent to a permanent raw Git copy. */
function shareableListing(listing: BotListing): {
  listing: unknown;
  omitted: OmittedField[];
} {
  const operator: Partial<BotListing["operator"]> = { ...listing.operator };
  const disclosure: Partial<BotListing["disclosure"]> = {
    ...listing.disclosure,
  };
  const omitted: OmittedField[] = [];
  if (
    disclosure.contact === null ||
    (typeof disclosure.contact === "string" &&
      /^(?:mailto:)?[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/i.test(
        disclosure.contact.trim(),
      ))
  ) {
    delete disclosure.contact;
    delete disclosure.contactEmailPublic;
    omitted.push("disclosure.contact", "disclosure.contactEmailPublic");
  }
  if (operator.shown === false) {
    delete operator.name;
    omitted.push("operator.name");
  }
  return { listing: { ...listing, operator, disclosure }, omitted };
}

/** No code installation, posting, remote Git operation or template download. */
export async function initializeBot(options: {
  args: string[];
  flags: InitFlags;
  env: NodeJS.ProcessEnv;
  prompt?: ((question: string) => Promise<string>) | null;
  selectBot?: () => Promise<string | undefined>;
  prefill: (bot: string) => Promise<BotPrefill>;
}): Promise<InitResult> {
  const { args, flags } = options;
  if (args.length > 1)
    throw new UsageError("Use init [dir] followed by options.");
  if (!flags.yes && !options.prompt)
    throw new UsageError("Use --yes for non-interactive init.");
  let chosen = flags.template;
  if (chosen === undefined)
    chosen = flags.yes
      ? "typescript"
      : (await options.prompt!("Template [typescript/python] (typescript): "))
          .trim()
          .toLowerCase() || "typescript";
  if (!isTemplateName(chosen))
    throw new UsageError("Use --template typescript or --template python.");
  let target = args[0];
  if (target === undefined)
    target = flags.yes
      ? DEFAULT_DIRECTORY
      : (await options.prompt!(`Directory (${DEFAULT_DIRECTORY}): `)).trim() ||
        DEFAULT_DIRECTORY;
  if (!target || /[\u0000-\u001f\u007f]/.test(target))
    throw new UsageError("Choose a directory without control characters.");
  const destination = path.resolve(target);
  // Refuse a nonempty destination even with --yes; it never means overwrite.
  try {
    const info = await lstat(destination);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await readdir(destination)).length
    )
      throw new UsageError(
        `Directory is not empty or is not a regular directory: ${destination}`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const template = await loadTemplate(chosen);
  let bot = flags.bot;
  if (bot === undefined && !flags.yes) {
    bot = options.selectBot
      ? await options.selectBot()
      : (
          await options.prompt!(
            "Bot handle or DID to prefill (optional, blank to skip): ",
          )
        ).trim() || undefined;
  }
  const prefill = bot === undefined ? undefined : await options.prefill(bot);
  const files = template.files.map((file) => ({
    ...file,
    bytes: Buffer.from(file.bytes),
  }));
  const listing = files.find((file) => file.path === "bluesky-bot.json")!;
  let omitted: OmittedField[] = [];
  if (prefill?.listing) {
    const safe = shareableListing(prefill.listing);
    omitted = safe.omitted;
    listing.bytes = Buffer.from(`${JSON.stringify(safe.listing, null, 2)}\n`);
  }
  if (prefill) {
    const env = files.find((file) => file.path === ".env.example")!;
    if (!/^BLUESKY_HANDLE=.*$/m.test(env.bytes.toString("utf8")))
      throw new TemplateError(
        "template_corrupt",
        "The template has no BLUESKY_HANDLE placeholder.",
      );
    env.bytes = Buffer.from(
      env.bytes
        .toString("utf8")
        .replace(
          /^BLUESKY_HANDLE=.*$/m,
          () => `BLUESKY_HANDLE=${JSON.stringify(prefill.identifier)}`,
        ),
    );
  }
  if (chosen === "typescript") {
    const file = files.find((file) => file.path === "package.json")!;
    const pkg = JSON.parse(file.bytes.toString("utf8"));
    pkg.name =
      path
        .basename(destination)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[._-]+/, "")
        .slice(0, 214) || DEFAULT_DIRECTORY;
    file.bytes = Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`);
  }

  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  let staging = await mkdtemp(path.join(parent, ".bsbot-init-"));
  try {
    for (const file of files) {
      const output = path.join(staging, file.path);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, file.bytes, { flag: "wx", mode: file.mode });
      await chmod(output, file.mode);
    }
    // Renaming over a concurrently populated directory fails, without clobbering it.
    await rename(staging, destination);
    staging = "";
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }

  if (!flags["no-git"]) {
    // Respect Git's identity, signing and hooks. Do not forward the API secret.
    const { BSBOT_TOKEN: _token, ...env } = options.env;
    // A caller's repository context must never redirect init/add/commit elsewhere.
    for (const name of [
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ])
      delete env[name];
    try {
      await execute("git", ["init", "--quiet", "--initial-branch=main"], {
        cwd: destination,
        env,
      });
      await execute("git", ["add", "--all"], { cwd: destination, env });
      await execute(
        "git",
        [
          "commit",
          "--quiet",
          "-m",
          "chore: initialise le bot Bluesky [skip ci]",
        ],
        { cwd: destination, env },
      );
    } catch {
      throw new TemplateError(
        "git_failed",
        `Files were created in ${destination}, but Git initialization or the first commit failed. Review your Git identity/signing/hooks and commit manually, or choose --no-git for a new directory.`,
      );
    }
  }
  return {
    dir: destination,
    template: chosen,
    files: files.map((file) => file.path).sort(),
    development: !template.provenance.published,
    omitted,
  };
}
