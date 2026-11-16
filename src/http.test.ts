import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { BotListing } from "./api.ts";

const execute = promisify(execFile);
const directory = path.resolve(import.meta.dirname, "..");
const DID = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "did:plc:cccccccccccccccccccccccc";
const TOKEN = "bsbot_synthetic-deploy-token";
const ORIGINAL: BotListing = {
  listed: true,
  category: "weather",
  description: "Daily weather observations.",
  languages: ["en"],
  showRecentPosts: false,
  operator: { name: "A creator", shown: true },
  usage: [],
  sourceUrl: null,
  openSource: false,
  supportUrl: null,
  disclosure: {
    purpose: null,
    contact: null,
    usesGenerativeAi: null,
    automationLevel: null,
    activities: [],
  },
};

let root: string;
let url: string;
let listing: BotListing;
let patchStatus: number;
let requests: {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
  agent: string | undefined;
}[];

function answer(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function receive(request: IncomingMessage, response: ServerResponse) {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  const body = text ? JSON.parse(text) : undefined;
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push({
    method: request.method ?? "GET",
    path: pathname,
    auth: request.headers.authorization,
    body,
    agent: request.headers["user-agent"],
  });
  // Receiver for the f4150f5 API contract plus disclosure additions in 675dd28.
  if (pathname.startsWith("/api/v1/resolve/")) {
    if (request.headers.authorization)
      return answer(response, 400, {
        error: {
          code: "credential_leak",
          message: "Public resolution must not carry a token.",
        },
      });
    return answer(response, 200, {
      did: pathname.endsWith("weather.bluesky.bot") ? DID : OTHER,
    });
  }
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return answer(response, 401, {
      error: { code: "unauthorized", message: "Unknown synthetic token." },
    });
  }
  if (pathname === "/api/v1/me") {
    return answer(response, 200, {
      creator: {
        did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
        handle: "creator.example.com",
      },
      token: {
        name: "Local CI",
        createdAt: "2026-11-01T00:00:00Z",
        expiresAt: "2027-11-01T00:00:00Z",
        kind: "deploy",
        scopes: ["listing"],
        botDid: DID,
      },
    });
  }
  if (pathname === "/api/v1/me/bots") {
    return answer(response, 403, {
      error: {
        code: "insufficient_scope",
        scope: "handles",
        message: "Deploy tokens cannot enumerate bots.",
      },
    });
  }
  if (pathname !== `/api/v1/me/bots/${encodeURIComponent(DID)}/listing`) {
    return answer(response, 404, {
      error: { code: "bot_not_found", message: "No owned bot." },
    });
  }
  if (request.method === "GET") return answer(response, 200, { listing });
  if (request.method !== "PATCH") return answer(response, 405, {});
  if (patchStatus === 429)
    return answer(response, 429, {
      error: {
        code: "rate_limited",
        message: "Too many changes.",
        retryAfterSeconds: 12,
      },
    });
  if (body.description === "refused")
    return answer(response, 400, {
      error: {
        code: "invalid_listing",
        message: "Description refused.",
        field: "description",
        reason: "brand",
      },
    });
  if (
    body.category === "ai" &&
    (body.disclosure?.usesGenerativeAi ??
      listing.disclosure.usesGenerativeAi) === null
  )
    return answer(response, 400, {
      error: {
        code: "invalid_listing",
        message: "An explicit AI disclosure is required.",
        field: "disclosure.usesGenerativeAi",
        reason: "required_for_ai",
      },
    });
  if (
    typeof body.disclosure?.contact === "string" &&
    /^(?:mailto:)?[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/i.test(
      body.disclosure.contact.trim(),
    ) &&
    body.disclosure.contactEmailPublic !== true
  )
    return answer(response, 400, {
      error: {
        code: "invalid_listing",
        message: "Explicit email publication consent is required.",
        field: "disclosure.contact",
        reason: "email_consent",
      },
    });
  const before = JSON.stringify(listing);
  listing = {
    ...listing,
    ...body,
    operator: { ...listing.operator, ...body.operator },
    disclosure: { ...listing.disclosure, ...body.disclosure },
  };
  return answer(response, 200, {
    listing,
    changed: JSON.stringify(listing) !== before,
  });
}

const server = createServer((request, response) => {
  void receive(request, response).catch(() =>
    answer(response, 500, {
      error: { code: "fixture_error", message: "Receiver failed." },
    }),
  );
});

async function cli(args: string[], changes: NodeJS.ProcessEnv = {}) {
  const options = {
    cwd: directory,
    env: {
      ...process.env,
      BSBOT_CONFIG_DIR: path.join(root, "credentials"),
      BSBOT_API_URL: url,
      BSBOT_TOKEN: TOKEN,
      ...changes,
    },
  };
  try {
    const output = await execute(
      process.execPath,
      ["dist/bin.js", ...args],
      options,
    );
    return { code: 0, ...output };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

beforeAll(async () => {
  // npm pretest builds once, before parallel HTTP and tarball readers start.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback receiver port");
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bsbot-http-"));
  listing = structuredClone(ORIGINAL);
  requests = [];
  patchStatus = 200;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("compiled CLI over real local HTTP", () => {
  it("resolves a deploy-token handle publicly and never enumerates owned bots", async () => {
    const result = await cli([
      "listing",
      "get",
      "weather.bluesky.bot",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ listing: ORIGINAL });
    expect(requests.map((r) => r.path)).toEqual([
      "/api/v1/me",
      "/api/v1/resolve/weather.bluesky.bot",
      `/api/v1/me/bots/${encodeURIComponent(DID)}/listing`,
    ]);
    expect(requests[1]?.auth).toBeUndefined();
    expect(requests.every((r) => r.agent?.startsWith("bsbot/"))).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("sends only a real diff, clears requested fields and keeps a repeated invocation read-only", async () => {
    const args = [
      "listing",
      "set",
      DID,
      "--listed",
      "false",
      "--category",
      "none",
      "--no-description",
      "--operator",
      "Weather team",
      "--hide-operator",
      "--json",
    ];
    const first = await cli(args);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).changed).toBe(true);
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({
      listed: false,
      category: null,
      description: null,
      operator: { name: "Weather team", shown: false },
    });
    requests = [];
    const second = await cli(args);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).changed).toBe(false);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("dry-run prints its diff but sends no PATCH", async () => {
    const result = await cli([
      "listing",
      "set",
      DID,
      "--listed=false",
      "--no-operator",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      changed: false,
      patch: { listed: false, operator: { name: null } },
    });
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("refuses unknown file fields before any HTTP request", async () => {
    const file = path.join(root, "listing.json");
    await writeFile(file, JSON.stringify({ operator: { visible: true } }));
    const result = await cli(["listing", "set", DID, "--file", file, "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain(
      "operator.visible",
    );
    expect(requests).toEqual([]);
  });

  it("preserves nested values when a valid file is combined with flags", async () => {
    const file = path.join(root, "listing.json");
    await writeFile(
      file,
      JSON.stringify({
        operator: { name: "A new creator" },
        languages: ["fr"],
      }),
    );
    const result = await cli([
      "listing",
      "set",
      DID,
      "--file",
      file,
      "--hide-operator",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(listing.operator).toEqual({ name: "A new creator", shown: false });
    expect(listing.languages).toEqual(["fr"]);
  });

  it("transmits explicit disclosure booleans without inventing AI answers or losing contact consent", async () => {
    listing.disclosure.contact = "old-contact@example.test";
    listing.disclosure.contactEmailPublic = true;
    const file = path.join(root, "listing.json");
    const wanted = {
      category: "ai",
      disclosure: {
        contact: "new-contact@example.test",
        contactEmailPublic: true,
        usesGenerativeAi: false,
      },
    };
    await writeFile(file, JSON.stringify(wanted));
    const result = await cli(["listing", "set", DID, "--file", file, "--json"]);
    expect(result.code).toBe(0);
    expect(
      requests.find((request) => request.method === "PATCH")?.body,
    ).toEqual(wanted);
    requests = [];
    expect(
      (await cli(["listing", "set", DID, "--file", file, "--json"])).code,
    ).toBe(0);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("keeps false email consent and reports required_for_ai without an invented answer or retry", async () => {
    listing.disclosure.contactEmailPublic = true;
    const file = path.join(root, "listing.json");
    await writeFile(
      file,
      JSON.stringify({ disclosure: { contactEmailPublic: false } }),
    );
    expect(
      (await cli(["listing", "set", DID, "--file", file, "--json"])).code,
    ).toBe(0);
    expect(
      requests.find((request) => request.method === "PATCH")?.body,
    ).toEqual({ disclosure: { contactEmailPublic: false } });
    requests = [];
    const refused = await cli([
      "listing",
      "set",
      DID,
      "--category",
      "ai",
      "--json",
    ]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr).error).toMatchObject({
      code: "invalid_listing",
      field: "disclosure.usesGenerativeAi",
      reason: "required_for_ai",
    });
    expect(
      requests
        .filter((request) => request.method === "PATCH")
        .map((request) => request.body),
    ).toEqual([{ category: "ai" }]);
  });

  it("shows type/scopes/bot without ever exposing the bearer token", async () => {
    const result = await cli(["whoami"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("type: deploy");
    expect(result.stdout).toContain("scopes: listing");
    expect(result.stdout).toContain(DID);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("init explicitly prefills a bot through the listing API without persisting its token", async () => {
    const dir = path.join(root, "starter");
    const result = await cli([
      "init",
      dir,
      "--template",
      "typescript",
      "--bot",
      "weather.bluesky.bot",
      "--yes",
      "--no-git",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dir,
      template: "typescript",
    });
    expect(
      JSON.parse(await readFile(path.join(dir, "bluesky-bot.json"), "utf8")),
    ).toEqual(ORIGINAL);
    const env = await readFile(path.join(dir, ".env.example"), "utf8");
    expect(env).toContain('BLUESKY_HANDLE="weather.bluesky.bot"');
    expect(env).toContain('BSBOT_TOKEN=""');
    expect(env + result.stdout + result.stderr).not.toContain(TOKEN);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.some((request) => request.path === "/api/v1/me/bots")).toBe(
      false,
    );
  });

  it("a failed bot prefill leaves no destination or partially generated files", async () => {
    const dir = path.join(root, "refused-starter");
    const result = await cli([
      "init",
      dir,
      "--template",
      "python",
      "--bot",
      OTHER,
      "--yes",
      "--no-git",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("bot_not_found");
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const publicEmail of [false, true])
    it(`init never copies an email or hidden operator into files, output or Git (consent=${publicEmail})`, async () => {
      const email = "synthetic-private-contact@example.test";
      const hidden = "Synthetic Hidden Operator";
      listing.disclosure.contact = email;
      listing.disclosure.contactEmailPublic = publicEmail;
      listing.operator = { name: hidden, shown: false };
      const privateGet = await cli(["listing", "get", DID, "--json"]);
      expect(privateGet.code).toBe(0);
      expect(JSON.parse(privateGet.stdout).listing).toMatchObject({
        disclosure: { contact: email, contactEmailPublic: publicEmail },
        operator: { name: hidden, shown: false },
      });
      const dir = path.join(root, "private-starter");
      const result = await cli(
        ["init", dir, "--template", "python", "--bot", DID, "--yes", "--json"],
        {
          GIT_AUTHOR_NAME: "Synthetic Creator",
          GIT_AUTHOR_EMAIL: "creator@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Synthetic Creator",
          GIT_COMMITTER_EMAIL: "creator@users.noreply.github.com",
        },
      );
      expect(result.code).toBe(0);
      const generated = JSON.parse(
        await readFile(path.join(dir, "bluesky-bot.json"), "utf8"),
      );
      expect(generated.disclosure).not.toHaveProperty("contact");
      expect(generated.disclosure).not.toHaveProperty("contactEmailPublic");
      expect(generated.operator).toEqual({ shown: false });
      expect(result.stderr).toContain(
        "disclosure.contact, disclosure.contactEmailPublic, operator.name",
      );
      const files = JSON.parse(result.stdout).files as string[];
      const fileBytes = (
        await Promise.all(
          files.map((file) => readFile(path.join(dir, file), "utf8")),
        )
      ).join("\n");
      const committed = (
        await execute("git", ["-C", dir, "show", "HEAD:bluesky-bot.json"])
      ).stdout;
      for (const privateValue of [email, hidden, TOKEN])
        expect(
          result.stdout + result.stderr + fileBytes + committed,
        ).not.toContain(privateValue);
      requests = [];
      expect(
        (
          await cli([
            "listing",
            "set",
            DID,
            "--file",
            path.join(dir, "bluesky-bot.json"),
            "--json",
          ])
        ).code,
      ).toBe(0);
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      expect(listing.disclosure.contact).toBe(email);
      expect(listing.operator.name).toBe(hidden);
    });

  it("keeps error details and rate limits in their existing JSON error envelope", async () => {
    const refused = await cli([
      "listing",
      "set",
      DID,
      "--description",
      "refused",
      "--json",
    ]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({
      error: {
        code: "invalid_listing",
        message: "Description refused.",
        field: "description",
        reason: "brand",
      },
    });
    patchStatus = 429;
    const limited = await cli(["listing", "set", DID, "--unlisted", "--json"]);
    expect(limited.code).toBe(1);
    expect(JSON.parse(limited.stderr).error).toEqual({
      code: "rate_limited",
      message: "Too many changes. (retry in 12 s)",
    });
  });

  it("refuses a short name for deploy tokens and does not try a handles endpoint", async () => {
    const result = await cli(["listing", "get", "weather", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("full handle");
    expect(requests.map((r) => r.path)).toEqual(["/api/v1/me"]);
  });

  it("refuses an unbound bot without leaking its listing", async () => {
    const result = await cli(["listing", "get", OTHER, "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("bot_not_found");
    expect(result.stdout).toBe("");
  });

  it("an explicitly empty environment token never falls back to a credentials file", async () => {
    const config = path.join(root, "credentials");
    await mkdir(config);
    const file = path.join(config, "credentials.json");
    const content = JSON.stringify({
      version: 1,
      apiUrl: url,
      token: TOKEN,
      did: DID,
      handle: "creator.example.com",
      expiresAt: "2027-11-01T00:00:00Z",
    });
    await writeFile(file, content, { mode: 0o644 });
    await chmod(file, 0o644);
    const result = await cli(["whoami", "--json"], { BSBOT_TOKEN: " " });
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(content);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });
});
