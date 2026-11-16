import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeTemplate,
  safeTemplateFilePath,
  TEMPLATE_NAMES,
} from "../dist/templates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "templates/manifest.json"), "utf8"),
);
if (
  manifest.version !== 1 ||
  Object.keys(manifest.templates).sort().join(",") !==
    [...TEMPLATE_NAMES].sort().join(",")
)
  throw new Error("Unexpected template manifest");

async function filesIn(directory, relative = "") {
  const names = [];
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error("Template symlinks are refused");
    if (entry.isDirectory()) names.push(...(await filesIn(directory, name)));
    else if (entry.isFile()) names.push(name);
    else throw new Error("Unexpected template file type");
  }
  return names.sort();
}

for (const name of TEMPLATE_NAMES) {
  const { files, ...provenance } = manifest.templates[name];
  const source = path.join(root, "templates/snapshots", name);
  if (
    !Array.isArray(files) ||
    files.some((file) => !safeTemplateFilePath(file.path))
  )
    throw new Error("Invalid template file manifest");
  if (
    JSON.stringify(await filesIn(source)) !==
    JSON.stringify(files.map((file) => file.path).sort())
  )
    throw new Error(`Template file list differs: ${name}`);
  const payload = { version: 1, name, provenance, files: [] };
  for (const expected of files) {
    const file = path.join(source, expected.path);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Not a regular template file: ${name}`);
    const bytes = await readFile(file);
    if (
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256 ||
      (info.mode & 0o777) !== expected.mode
    )
      throw new Error(`Template bytes/mode differ: ${name}/${expected.path}`);
    payload.files.push({ ...expected, content: bytes.toString("base64") });
  }
  decodeTemplate(payload, name);
  if (!process.argv.includes("--check")) {
    await mkdir(path.join(root, "dist/templates"), { recursive: true });
    await writeFile(
      path.join(root, "dist/templates", `${name}.json`),
      `${JSON.stringify(payload)}\n`,
    );
  }
}
