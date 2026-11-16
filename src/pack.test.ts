import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("the npm tarball generates both complete starters outside the source checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bsbot-pack-"));
  try {
    // pretest built the package; packing must not install or execute bot code.
    const packed = await execute(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: path.resolve(import.meta.dirname, "..") },
    );
    const archive = JSON.parse(packed.stdout)[0];
    const names = archive.files.map(
      (file: { path: string }) => file.path,
    ) as string[];
    expect(names).toContain("dist/templates/typescript.json");
    expect(names).toContain("dist/templates/python.json");
    expect(
      names.some(
        (name) =>
          name.startsWith("templates/") || name.includes("node_modules/"),
      ),
    ).toBe(false);
    await execute("tar", [
      "-xzf",
      path.join(root, archive.filename),
      "-C",
      root,
    ]);
    const pkg = JSON.parse(
      await readFile(path.join(root, "package/package.json"), "utf8"),
    );
    expect(pkg.dependencies).toBeUndefined();
    for (const template of ["typescript", "python"]) {
      const destination = path.join(root, `${template}-bot`);
      const result = await execute(
        process.execPath,
        [
          path.join(root, "package/dist/bin.js"),
          "init",
          destination,
          "--template",
          template,
          "--yes",
          "--no-git",
          "--json",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            BSBOT_CONFIG_DIR: path.join(root, "unused-credentials"),
            BSBOT_TOKEN: undefined,
            HTTP_PROXY: "http://127.0.0.1:1",
            HTTPS_PROXY: "http://127.0.0.1:1",
            NODE_USE_ENV_PROXY: "1",
          },
        },
      );
      const answer = JSON.parse(result.stdout);
      expect(answer).toMatchObject({ dir: destination, template });
      expect(answer.files).toContain(".gitignore");
      expect(answer.files).toContain(".github/workflows/bot.yml");
      expect(
        await readFile(
          path.join(destination, ".github/workflows/bot.yml"),
          "utf8",
        ),
      ).toContain("workflow_dispatch");
      const env = await readFile(
        path.join(destination, ".env.example"),
        "utf8",
      );
      expect(env).toContain('BLUESKY_APP_PASSWORD=""');
      expect(env).toContain('BSBOT_TOKEN=""');
      expect(await readdir(destination)).not.toContain("node_modules");
      expect(await readdir(destination)).not.toContain(".env");
      expect(await readdir(destination)).not.toContain(".git");
      expect(result.stderr).toContain("unpublished development snapshot");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
