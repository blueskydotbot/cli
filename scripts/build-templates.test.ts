import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execute = promisify(execFile);
let root: string;
type Manifest = {
  templates: Record<string, { files: { path: string; mode: number }[] }>;
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bsbot-template-build-"));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await copyFile(
    new URL("./build-templates.mjs", import.meta.url),
    path.join(root, "scripts/build-templates.mjs"),
  );
  await copyFile(
    new URL("../dist/templates.js", import.meta.url),
    path.join(root, "dist/templates.js"),
  );
  await cp(new URL("../templates", import.meta.url), path.join(root, "templates"), {
    recursive: true,
  });
  const manifest: Manifest = JSON.parse(
    await readFile(path.join(root, "templates/manifest.json"), "utf8"),
  );
  for (const [name, template] of Object.entries(manifest.templates)) {
    for (const file of template.files) {
      await chmod(
        path.join(root, "templates/snapshots", name, file.path),
        file.mode === 0o755 ? 0o700 : 0o600,
      );
    }
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const build = () =>
  execute(process.execPath, [path.join(root, "scripts/build-templates.mjs")]);

it("builds an unchanged Git tree checked out with a restrictive umask", async () => {
  await build();
  const payload = JSON.parse(
    await readFile(path.join(root, "dist/templates/typescript.json"), "utf8"),
  );
  const manifest: Manifest = JSON.parse(
    await readFile(path.join(root, "templates/manifest.json"), "utf8"),
  );
  expect(payload.files.map(({ path, mode }: { path: string; mode: number }) => ({ path, mode })))
    .toEqual(manifest.templates.typescript.files.map(({ path, mode }) => ({ path, mode })));
});

it("preserves the canonical executable mode when group and other permissions are masked", async () => {
  const manifestPath = path.join(root, "templates/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.templates.typescript.files.find(
    (file: { path: string }) => file.path === "README.md",
  ).mode = 0o755;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await chmod(path.join(root, "templates/snapshots/typescript/README.md"), 0o700);
  await build();
  const payload = JSON.parse(
    await readFile(path.join(root, "dist/templates/typescript.json"), "utf8"),
  );
  expect(
    payload.files.find((file: { path: string }) => file.path === "README.md").mode,
  ).toBe(0o755);
});

it("still rejects a changed executable bit", async () => {
  await chmod(path.join(root, "templates/snapshots/typescript/README.md"), 0o700);
  await expect(build()).rejects.toThrow("Template bytes/mode differ: typescript/README.md");
});
