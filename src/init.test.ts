import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "./cli.ts";
import { decodeTemplate, loadTemplate, TEMPLATE_NAMES } from "./templates.ts";

const execute = promisify(execFile);
let root: string;
let output: string[];
let errors: string[];
const io = (overrides: Partial<Io> = {}): Io => ({
  env: {
    ...process.env,
    BSBOT_CONFIG_DIR: path.join(root, "credentials"),
    BSBOT_TOKEN: undefined,
  },
  stdout: (value) => output.push(value),
  stderr: (value) => errors.push(value),
  fetch: vi.fn(async () => {
    throw new Error("Unexpected network request");
  }),
  openBrowser: vi.fn(),
  confirm: null,
  ...overrides,
});
const stdout = () => output.join("");
const stderr = () => errors.join("");

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bsbot-init-"));
  output = [];
  errors = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("offline bundled init", () => {
  for (const template of TEMPLATE_NAMES) {
    it(`generates the complete ${template} tree without network, account or Git`, async () => {
      const dir = path.join(root, `my-${template}-bot`);
      const context = io();
      expect(
        await run(
          ["init", dir, "--template", template, "--no-git", "--yes", "--json"],
          context,
        ),
      ).toBe(0);
      const answer = JSON.parse(stdout());
      expect(Object.keys(answer).sort()).toEqual(["dir", "files", "template"]);
      expect(answer.dir).toBe(dir);
      expect(answer.template).toBe(template);
      const bundled = await loadTemplate(template);
      expect(answer.files).toEqual(
        bundled.files.map((file) => file.path).sort(),
      );
      for (const file of bundled.files) {
        const bytes = await readFile(path.join(dir, file.path));
        if (file.path !== "package.json") expect(bytes).toEqual(file.bytes);
        expect((await lstat(path.join(dir, file.path))).mode & 0o777).toBe(
          file.mode,
        );
      }
      if (template === "typescript")
        expect(
          JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))
            .name,
        ).toBe("my-typescript-bot");
      expect(await readdir(dir)).not.toContain(".git");
      expect(context.fetch).not.toHaveBeenCalled();
      expect(stderr()).toContain("unpublished development snapshot");
      expect(await readdir(dir)).not.toContain(".env");
    });
  }

  it("prefills a full handle without authentication or any network request", async () => {
    const context = io();
    const dir = path.join(root, "bot");
    expect(
      await run(
        [
          "init",
          dir,
          "--template",
          "python",
          "--bot",
          "@weather.example.com",
          "--yes",
          "--no-git",
        ],
        context,
      ),
    ).toBe(0);
    expect(await readFile(path.join(dir, ".env.example"), "utf8")).toContain(
      'BLUESKY_HANDLE="weather.example.com"',
    );
    expect(context.fetch).not.toHaveBeenCalled();
  });

  it("prompts for language, directory and an optional bot, never for a password", async () => {
    const dir = path.join(root, "interactive");
    const answers = ["python", dir, ""];
    const prompt = vi.fn(async () => answers.shift() ?? "");
    expect(await run(["init", "--no-git", "--json"], io({ prompt }))).toBe(0);
    expect(JSON.parse(stdout()).template).toBe("python");
    expect(prompt.mock.calls).toHaveLength(3);
    expect(prompt.mock.calls.flat().join(" ").toLowerCase()).not.toContain(
      "password",
    );
  });

  it("--yes bypasses prompting and uses TypeScript when no template is specified", async () => {
    const dir = path.join(root, "defaults");
    const prompt = vi.fn(async () => {
      throw new Error("Must not prompt");
    });
    expect(
      await run(["init", dir, "--no-git", "--yes", "--json"], io({ prompt })),
    ).toBe(0);
    expect(JSON.parse(stdout()).template).toBe("typescript");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("lets an authorized creator pick an owned bot interactively and prefills only that private listing", async () => {
    const dir = path.join(root, "selected");
    const did = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
    const listing = {
      listed: false,
      category: "weather",
      description: "A chosen weather bot",
      languages: ["en"],
      showRecentPosts: false,
      operator: { name: "A public operator", shown: true },
      usage: [],
      sourceUrl: null,
      openSource: false,
      supportUrl: null,
      disclosure: {
        purpose: null,
        contact: "@creator.example.com",
        contactEmailPublic: false,
        usesGenerativeAi: false,
        automationLevel: "automated",
        activities: [],
      },
    };
    const paths: string[] = [];
    const context = io();
    context.env.BSBOT_TOKEN = "bsbot_synthetic-cli-token";
    const answers = ["python", dir, "1"];
    context.prompt = vi.fn(async () => answers.shift() ?? "");
    context.fetch = vi.fn(async (input) => {
      const pathname = new URL(String(input)).pathname;
      paths.push(pathname);
      if (pathname === "/api/v1/me")
        return Response.json({
          creator: { did, handle: "creator.example.com" },
          token: { kind: "cli", scopes: ["handles", "listing"], botDid: null },
        });
      if (pathname === "/api/v1/me/bots")
        return Response.json({
          bots: [{ did, handle: "weather.bluesky.bot" }],
        });
      if (pathname === `/api/v1/me/bots/${encodeURIComponent(did)}/listing`)
        return Response.json({ listing });
      throw new Error("Unexpected request");
    });
    expect(await run(["init", "--no-git", "--json"], context)).toBe(0);
    expect(paths).toEqual([
      "/api/v1/me",
      "/api/v1/me/bots",
      `/api/v1/me/bots/${encodeURIComponent(did)}/listing`,
    ]);
    expect(stderr()).toContain("1. weather.bluesky.bot");
    expect(
      JSON.parse(await readFile(path.join(dir, "bluesky-bot.json"), "utf8")),
    ).toEqual(listing);
    expect(await readFile(path.join(dir, ".env.example"), "utf8")).toContain(
      `BLUESKY_HANDLE="${did}"`,
    );
  });

  for (const token of [
    { kind: "deploy", scopes: ["listing"] },
    { kind: "cli", scopes: ["listing"] },
    {},
  ])
    it(`does not enumerate bots without explicit permission (${JSON.stringify(token)})`, async () => {
      const dir = path.join(root, "no-enumeration");
      const context = io();
      context.env.BSBOT_TOKEN = "bsbot_synthetic-token";
      const answers = ["python", dir, ""];
      context.prompt = vi.fn(async () => answers.shift() ?? "");
      context.fetch = vi.fn(async (input) => {
        expect(new URL(String(input)).pathname).toBe("/api/v1/me");
        return Response.json({ token });
      });
      expect(await run(["init", "--no-git", "--json"], context)).toBe(0);
      expect(context.fetch).toHaveBeenCalledTimes(1);
      expect(stderr()).not.toContain("Your bots:");
      expect(await readdir(dir)).toContain("bot.py");
    });

  it("still generates offline when optional owned-bot choices cannot be loaded", async () => {
    const dir = path.join(root, "offline-with-credentials");
    const context = io();
    context.env.BSBOT_TOKEN = "bsbot_synthetic-offline-token";
    const answers = ["python", dir, ""];
    context.prompt = vi.fn(async () => answers.shift() ?? "");
    expect(await run(["init", "--no-git", "--json"], context)).toBe(0);
    expect(stderr()).toContain("Owned bot choices are unavailable");
    expect(await readdir(dir)).toContain("bot.py");
  });

  it("refuses non-interactive ambiguity, unknown templates and surplus arguments before writing", async () => {
    const dir = path.join(root, "refused");
    for (const args of [
      ["init", dir],
      ["init", dir, "--template", "shell", "--yes"],
      ["init", dir, "extra", "--yes"],
    ])
      expect(await run(args, io())).toBe(2);
    expect(await readdir(root)).toEqual([]);
  });

  it("never overwrites a populated destination, even with --yes", async () => {
    const dir = path.join(root, "existing");
    await mkdir(dir);
    await writeFile(path.join(dir, "keep.txt"), "keep me");
    expect(await run(["init", dir, "--yes", "--no-git"], io())).toBe(2);
    expect(await readFile(path.join(dir, "keep.txt"), "utf8")).toBe("keep me");
    expect(await readdir(dir)).toEqual(["keep.txt"]);
  });

  it("quotes the printed cd argument literally, including shell substitutions", async () => {
    const dir = path.join(
      root,
      "owner's $(touch PWNED) `touch ALSO_PWNED` bot",
    );
    expect(await run(["init", dir, "--yes", "--no-git"], io())).toBe(0);
    const command = stdout()
      .split("\n")
      .find((line) => line.startsWith("  cd "))!
      .trim();
    // Run only the printed cd in a disposable directory; substitutions must stay literal.
    const result = await execute("sh", ["-c", `${command} && pwd`], {
      cwd: root,
    });
    expect(result.stdout.trim()).toBe(dir);
    expect(await readdir(root)).toEqual([path.basename(dir)]);
  });

  it("refuses a symlink destination and accepts an actually empty directory", async () => {
    const actual = path.join(root, "actual");
    await mkdir(actual);
    const link = path.join(root, "link");
    await symlink(actual, link);
    expect(await run(["init", link, "--yes", "--no-git"], io())).toBe(2);
    expect(await readdir(actual)).toEqual([]);
    expect(await run(["init", actual, "--yes", "--no-git"], io())).toBe(0);
    expect(await readdir(actual)).toContain(".gitignore");
  });

  it("creates a real first Git commit without overriding identity or bypassing hooks", async () => {
    const dir = path.join(root, "git-bot");
    const context = io();
    Object.assign(context.env, {
      GIT_AUTHOR_NAME: "Synthetic Creator",
      GIT_AUTHOR_EMAIL: "creator@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Synthetic Creator",
      GIT_COMMITTER_EMAIL: "creator@users.noreply.github.com",
    });
    expect(
      await run(
        ["init", dir, "--template", "python", "--yes", "--json"],
        context,
      ),
    ).toBe(0);
    expect(
      (
        await execute("git", ["-C", dir, "log", "-1", "--format=%an <%ae>"])
      ).stdout.trim(),
    ).toBe("Synthetic Creator <creator@users.noreply.github.com>");
    expect(
      (await execute("git", ["-C", dir, "status", "--porcelain"])).stdout,
    ).toBe("");
    expect(
      (
        await execute("git", [
          "-C",
          dir,
          "ls-files",
          ".github/workflows/bot.yml",
          ".gitignore",
        ])
      ).stdout
        .trim()
        .split("\n"),
    ).toEqual([".github/workflows/bot.yml", ".gitignore"]);
  });

  it("honours a rejecting Git hook and preserves the generated files for review", async () => {
    const hooks = path.join(root, "git-template", "hooks");
    await mkdir(hooks, { recursive: true });
    const hook = path.join(hooks, "pre-commit");
    await writeFile(hook, "#!/bin/sh\nprintf checked > hook-ran\nexit 1\n");
    await chmod(hook, 0o755);
    const dir = path.join(root, "hooked");
    const context = io();
    Object.assign(context.env, {
      GIT_TEMPLATE_DIR: path.dirname(hooks),
      GIT_AUTHOR_NAME: "Synthetic Creator",
      GIT_AUTHOR_EMAIL: "creator@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Synthetic Creator",
      GIT_COMMITTER_EMAIL: "creator@users.noreply.github.com",
    });
    expect(
      await run(
        ["init", dir, "--template", "python", "--yes", "--json"],
        context,
      ),
    ).toBe(1);
    expect(
      JSON.parse(
        stderr()
          .split("\n")
          .find((line) => line.startsWith("{"))!,
      ).error.code,
    ).toBe("git_failed");
    expect(await readFile(path.join(dir, "hook-ran"), "utf8")).toBe("checked");
    expect(await readdir(dir)).toContain("bot.py");
  });

  it("never redirects Git writes into an ambient repository or index", async () => {
    const external = path.join(root, "external");
    await mkdir(external);
    await execute("git", ["init", "--quiet", external]);
    const index = path.join(root, "external-index");
    await writeFile(index, "must remain untouched");
    const dir = path.join(root, "isolated-bot");
    const context = io();
    Object.assign(context.env, {
      GIT_DIR: path.join(external, ".git"),
      GIT_WORK_TREE: external,
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: "Synthetic Creator",
      GIT_AUTHOR_EMAIL: "creator@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Synthetic Creator",
      GIT_COMMITTER_EMAIL: "creator@users.noreply.github.com",
    });
    expect(
      await run(
        ["init", dir, "--template", "python", "--yes", "--json"],
        context,
      ),
    ).toBe(0);
    expect(await readFile(index, "utf8")).toBe("must remain untouched");
    expect((await execute("git", ["-C", external, "ls-files"])).stdout).toBe(
      "",
    );
    expect(
      (
        await execute("git", ["-C", dir, "rev-list", "--count", "HEAD"])
      ).stdout.trim(),
    ).toBe("1");
  });
});

describe("template integrity", () => {
  async function payload() {
    return JSON.parse(
      await readFile(
        new URL("../dist/templates/python.json", import.meta.url),
        "utf8",
      ),
    );
  }
  it("rejects altered content, executable escalation, case collisions, traversal, secrets and Git paths", async () => {
    for (const change of [
      (p: any) => {
        p.files[0].content = Buffer.from("altered").toString("base64");
      },
      (p: any) => {
        p.files[0].mode = 0o777;
      },
      (p: any) => {
        p.files.push({ ...p.files[0], path: p.files[0].path.toUpperCase() });
      },
      (p: any) => {
        p.files[0].path = "../escaped";
      },
      (p: any) => {
        p.files[0].path = ".env";
      },
      (p: any) => {
        p.files[0].path = ".git/config";
      },
      (p: any) => {
        p.provenance.published = true;
      },
    ]) {
      const value = await payload();
      change(value);
      expect(() => decodeTemplate(value, "python")).toThrow("integrity check");
    }
  });

  it("blocks publishing development snapshots before making a Git network request", async () => {
    await expect(
      execute(process.execPath, ["scripts/verify-template-provenance.mjs"], {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, PATH: "" },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unpublished development snapshot"),
    });
  });
});
