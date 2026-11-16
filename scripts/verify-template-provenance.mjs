import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { decodeTemplate, TEMPLATE_NAMES } from "../dist/templates.js";

const execute = promisify(execFile);
const root = new URL("../", import.meta.url);
// Local preparation stays usable, but no development snapshot may be published.
for (const name of TEMPLATE_NAMES) {
  const payload = JSON.parse(
    await readFile(new URL(`dist/templates/${name}.json`, root), "utf8"),
  );
  const template = decodeTemplate(payload, name);
  if (!template.provenance.published || !template.provenance.ref)
    throw new Error(
      `Template ${name} is an unpublished development snapshot; verify a real immutable tag before publishing the CLI.`,
    );
}

for (const name of TEMPLATE_NAMES) {
  const payload = JSON.parse(
    await readFile(new URL(`dist/templates/${name}.json`, root), "utf8"),
  );
  const template = decodeTemplate(payload, name);
  const checkout = await mkdtemp(
    path.join(tmpdir(), "bsbot-template-release-"),
  );
  try {
    // No checkout or script execution; only inspect immutable Git objects.
    await execute("git", [
      "clone",
      "--quiet",
      "--no-checkout",
      "--depth",
      "1",
      "--branch",
      template.provenance.ref.slice("refs/tags/".length),
      `https://github.com/${template.provenance.repository}.git`,
      checkout,
    ]);
    const commit = (
      await execute("git", ["-C", checkout, "rev-parse", "HEAD"])
    ).stdout.trim();
    if (commit !== template.provenance.commit)
      throw new Error(`Pinned commit differs: ${name}`);
    const tree = (
      await execute("git", ["-C", checkout, "ls-tree", "-r", "-z", "HEAD"])
    ).stdout
      .split("\0")
      .filter(Boolean);
    const actual = [];
    for (const entry of tree) {
      const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
      if (!match) throw new Error(`Unsupported template tree entry: ${name}`);
      const bytes = (
        await execute("git", ["-C", checkout, "cat-file", "blob", match[2]], {
          encoding: "buffer",
          maxBuffer: 2 * 1024 * 1024,
        })
      ).stdout;
      actual.push({
        path: match[3],
        mode: match[1] === "100755" ? 0o755 : 0o644,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const expected = template.files.map(({ path, mode, sha256 }) => ({
      path,
      mode,
      sha256,
    }));
    const sorted = (values) =>
      values.sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected)))
      throw new Error(`Bundled template differs from its pinned tag: ${name}`);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
