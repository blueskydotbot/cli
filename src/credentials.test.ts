import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Credentials,
  configDir,
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials.ts";

// The token file: 0600 in a 0700 folder.

const CREDENTIALS: Credentials = {
  version: 1,
  apiUrl: "https://bluesky.bot",
  token: "bsbot_test-token-not-real",
  did: "did:plc:clitestaaaaaaaaaaaaaaaaa",
  handle: "alice.test",
  expiresAt: "2026-12-01T00:00:00.000Z",
};

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bsbot-cli-"));
  env = { BSBOT_CONFIG_DIR: path.join(root, "config", "bsbot") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the config folder", () => {
  it("follows XDG_CONFIG_HOME, then ~/.config, unless overridden", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" })).toBe("/x/bsbot");
    expect(configDir({})).toMatch(/\.config\/bsbot$/);
    expect(configDir({ BSBOT_CONFIG_DIR: "/y", XDG_CONFIG_HOME: "/x" })).toBe(
      "/y",
    );
  });
});

describe("the credentials file", () => {
  it("is written 0600 in a 0700 folder, and read back", async () => {
    const file = await writeCredentials(env, CREDENTIALS);

    expect(file).toBe(credentialsPath(env));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readCredentials(env)).toEqual(CREDENTIALS);
  });

  it("tightens an existing folder and replaces the file atomically", async () => {
    const dir = configDir(env);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await writeCredentials(env, CREDENTIALS);
    await writeCredentials(env, { ...CREDENTIALS, handle: "bob.test" });

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readCredentials(env))?.handle).toBe("bob.test");
    // No temporary file left behind.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["credentials.json"]);
  });

  it("puts a file that others can read back to 0600", async () => {
    const file = await writeCredentials(env, CREDENTIALS);
    await chmod(file, 0o644);

    expect(await readCredentials(env)).toEqual(CREDENTIALS);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("ignores a missing, broken or foreign file", async () => {
    expect(await readCredentials(env)).toBeNull();

    await writeCredentials(env, CREDENTIALS);
    await writeFile(credentialsPath(env), "{not json");
    expect(await readCredentials(env)).toBeNull();

    await writeFile(credentialsPath(env), JSON.stringify({ token: "x" }));
    expect(await readCredentials(env)).toBeNull();
  });

  it("is deleted by logout, and deleting twice is fine", async () => {
    await writeCredentials(env, CREDENTIALS);
    await deleteCredentials(env);
    await deleteCredentials(env);

    expect(await readCredentials(env)).toBeNull();
    await expect(readFile(credentialsPath(env))).rejects.toThrow();
  });
});
