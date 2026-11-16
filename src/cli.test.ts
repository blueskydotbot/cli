import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotListing, Checkup, MyBot } from "./api.ts";
import { findBot, type Io, run } from "./cli.ts";
import {
  credentialsPath,
  readCredentials,
  writeCredentials,
} from "./credentials.ts";

// Every command through `run`, against a fake server: no network, no browser.

const API = "https://bluesky.bot";
const TOKEN = "bsbot_fake-token-for-tests-only";
const DID = "did:plc:clitestaaaaaaaaaaaaaaaaa";

const BOT: MyBot = {
  did: "did:plc:clibotaaaaaaaaaaaaaaaaaa",
  handle: "weather.bluesky.bot",
  previousHandle: "weather.bsky.social",
  displayName: "Weather",
  avatar: null,
  verifiedAt: "2026-10-01T00:00:00.000Z",
  listed: true,
  status: "active",
};
const NEW_BOT: MyBot = {
  ...BOT,
  did: "did:plc:clibotbbbbbbbbbbbbbbbbbb",
  handle: null,
  previousHandle: "news.bsky.social",
  verifiedAt: null,
  listed: false,
};

let root: string;
let out: string[];
let err: string[];
let calls: Array<{
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}>;
let routes: Record<string, (body: unknown) => Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function io(overrides: Partial<Io> = {}): Io {
  return {
    env: { BSBOT_CONFIG_DIR: path.join(root, "cfg") },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, auth: headers.Authorization ?? null, body });
      const route = routes[`${method} ${url.replace(`${API}/api/v1`, "")}`];
      return route
        ? route(body)
        : json(404, { error: { code: "not_found", message: "No." } });
    }) as unknown as typeof fetch,
    openBrowser: vi.fn(),
    confirm: null,
    ...overrides,
  };
}

const stdout = () => out.join("");
const stderr = () => err.join("");

async function signIn() {
  await writeCredentials(io().env, {
    version: 1,
    apiUrl: API,
    token: TOKEN,
    did: DID,
    handle: "alice.test",
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bsbot-run-"));
  out = [];
  err = [];
  calls = [];
  routes = {
    "GET /me/bots": () => json(200, { bots: [BOT, NEW_BOT] }),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bsbot login", () => {
  /**
   * Plays the browser and the authorization server: reads the authorize URL
   * the CLI printed, then sends the browser back to the loopback address with
   * a code; the token endpoint only accepts the verifier of the challenge.
   */
  function fakeAuthorizationServer(options: { deny?: boolean } = {}) {
    let challenge = "";
    let redirectUri = "";
    routes["POST /cli/token"] = (body) => {
      const b = body as Record<string, string>;
      const ok =
        b.code === "one-time-code" &&
        b.redirect_uri === redirectUri &&
        createHash("sha256")
          .update(b.code_verifier ?? "")
          .digest("base64url") === challenge;
      return ok
        ? json(200, {
            token: TOKEN,
            tokenType: "Bearer",
            expiresAt: "2026-11-30T00:00:00.000Z",
            creator: { did: DID, handle: "alice.test" },
          })
        : json(400, { error: { code: "invalid_grant", message: "Bad code." } });
    };
    return (text: string) => {
      err.push(text);
      const match = /https:\/\/bluesky\.bot\/cli\/authorize\?\S+/.exec(text);
      if (!match) return;
      const url = new URL(match[0]);
      challenge = url.searchParams.get("code_challenge") ?? "";
      redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state");
      const back = options.deny
        ? `${redirectUri}?error=access_denied&state=${state}`
        : `${redirectUri}?code=one-time-code&state=${state}`;
      setTimeout(() => void fetch(back), 10);
    };
  }

  it("signs in through the browser, and saves the token 0600 without printing it", async () => {
    const ioValue = io({ stderr: fakeAuthorizationServer() });
    const code = await run(["login"], ioValue);

    expect(code).toBe(0);
    expect(ioValue.openBrowser).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/bluesky\.bot\/cli\/authorize\?/),
    );
    expect(stdout()).toContain("✓ signed in as @alice.test");
    expect(stdout() + stderr()).not.toContain(TOKEN);

    const saved = await readCredentials(ioValue.env);
    expect(saved).toMatchObject({ apiUrl: API, token: TOKEN, did: DID });
    expect((await stat(credentialsPath(ioValue.env))).mode & 0o777).toBe(0o600);
  });

  it("asks for a S256 challenge on the loopback IP, with this machine's name", async () => {
    const ioValue = io({ stderr: fakeAuthorizationServer() });
    await run(["login", "--no-browser"], ioValue);

    expect(ioValue.openBrowser).not.toHaveBeenCalled();
    const url = new URL(/https:\S+/.exec(stderr())?.[0] ?? "");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(url.searchParams.get("client_name")).toBeTruthy();
  });

  it("names the token after --name, else this machine", async () => {
    await run(
      ["login", "--no-browser", "--name", "ci runner"],
      io({ stderr: fakeAuthorizationServer() }),
    );
    const url = new URL(/https:\S+/.exec(stderr())?.[0] ?? "");
    expect(url.searchParams.get("client_name")).toBe("ci runner");
  });

  it("gives JSON without the token", async () => {
    const code = await run(
      ["login", "--json"],
      io({ stderr: fakeAuthorizationServer() }),
    );

    expect(code).toBe(0);
    const body = JSON.parse(stdout());
    expect(body).toMatchObject({
      creator: { did: DID },
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("bsbot_");
  });

  it("stops when the creator cancels in the browser", async () => {
    const code = await run(
      ["login"],
      io({ stderr: fakeAuthorizationServer({ deny: true }) }),
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("Login cancelled");
    expect(await readCredentials(io().env)).toBeNull();
  });

  it("times out without a browser", async () => {
    const code = await run(
      ["login", "--no-browser"],
      io({ loginTimeoutMs: 50 }),
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("Timed out");
  });
});

describe("the account commands", () => {
  it("whoami shows the account behind the token", async () => {
    await signIn();
    routes["GET /me"] = () =>
      json(200, {
        creator: { did: DID, handle: "alice.test", displayName: null },
        token: {
          name: "laptop",
          createdAt: "2026-10-31T00:00:00.000Z",
          expiresAt: "2026-11-30T00:00:00.000Z",
        },
      });

    expect(await run(["whoami"], io())).toBe(0);
    expect(stdout()).toContain("@alice.test");
    expect(stdout()).toContain("2026-11-30");
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("asks to log in when there is no token, or one for another server", async () => {
    expect(await run(["whoami"], io())).toBe(1);
    expect(stderr()).toContain("bsbot login");

    await signIn();
    err = [];
    expect(
      await run(["bots", "--api-url", "http://localhost:3000"], io()),
    ).toBe(1);
    expect(stderr()).toContain("Signed in to https://bluesky.bot");
    expect(calls).toEqual([]);
  });

  it("says to log in again on a revoked token", async () => {
    await signIn();
    routes["GET /me/bots"] = () =>
      json(401, { error: { code: "unauthorized", message: "Revoked." } });

    expect(await run(["bots", "--json"], io())).toBe(1);
    expect(JSON.parse(stderr())).toEqual({
      error: {
        code: "unauthorized",
        message: "Revoked. Run `bsbot login`.",
      },
    });
  });

  it("logout revokes the token on the server, then forgets it", async () => {
    await signIn();
    routes["DELETE /me/token"] = () => new Response(null, { status: 204 });

    expect(await run(["logout"], io())).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({ method: "DELETE", auth: `Bearer ${TOKEN}` }),
    ]);
    expect(await readCredentials(io().env)).toBeNull();
  });

  it("logout still forgets a token the server already refuses", async () => {
    await signIn();
    routes["DELETE /me/token"] = () =>
      json(401, { error: { code: "unauthorized", message: "Revoked." } });

    expect(await run(["logout", "--json"], io())).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ signedOut: true, revoked: true });
    expect(await readCredentials(io().env)).toBeNull();
  });
});

describe("the handle commands", () => {
  beforeEach(signIn);

  it("check needs no token", async () => {
    await rm(path.join(root, "cfg"), { recursive: true });
    routes["GET /handles/weather/availability"] = () =>
      json(200, {
        name: "weather",
        handle: "weather.bluesky.bot",
        available: false,
        reason: "taken",
      });

    expect(await run(["check", "weather"], io())).toBe(0);
    expect(stdout()).toContain(
      "✗ weather.bluesky.bot is not available (taken)",
    );
    expect(calls[0]?.auth).toBeNull();
  });

  it("claim finds the bot by its previous handle and reports the switch", async () => {
    routes[`POST /me/bots/${encodeURIComponent(NEW_BOT.did)}/claim`] = () =>
      json(200, { handle: "news.bluesky.bot", switch: { status: "pending" } });

    expect(await run(["claim", "news.bsky.social", "news"], io())).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ name: "news" });
    expect(stdout()).toContain("✓ news.bluesky.bot is yours");
    expect(stdout()).toContain("bsbot verify news");
  });

  it("claim reports a refusal with the API's message", async () => {
    routes[`POST /me/bots/${encodeURIComponent(NEW_BOT.did)}/claim`] = () =>
      json(409, {
        error: {
          code: "conflict",
          message: "This handle is already taken.",
          reason: "taken",
        },
      });

    expect(await run(["claim", NEW_BOT.did, "weather"], io())).toBe(1);
    expect(stderr()).toContain("already taken");
  });

  it("tells a pending check from a pending switch", async () => {
    routes[`POST /me/bots/${encodeURIComponent(BOT.did)}/verify`] = () =>
      json(200, { switch: { status: "pending" } });
    routes[`POST /me/bots/${encodeURIComponent(BOT.did)}/switch`] = () =>
      json(200, { switch: { status: "pending" } });

    await run(["verify", "weather"], io());
    expect(stdout()).toContain("Bluesky does not show weather.bluesky.bot yet");
    expect(stdout()).not.toContain("set on the bot's server");

    out = [];
    await run(["switch", "weather"], io());
    expect(stdout()).toContain("is set on the bot's server");
  });

  it("points to the dashboard of the server in use", async () => {
    await writeCredentials(io().env, {
      version: 1,
      apiUrl: "http://localhost:3000",
      token: TOKEN,
      did: DID,
      handle: "alice.test",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    const local = io({
      fetch: vi.fn(async () =>
        json(200, { bots: [] }),
      ) as unknown as typeof fetch,
    });
    expect(
      await run(["bots", "--api-url", "http://localhost:3000"], local),
    ).toBe(0);
    expect(stdout()).toContain("http://localhost:3000/manage");
  });

  it("switch and verify print the outcome, manual steps included", async () => {
    routes[`POST /me/bots/${encodeURIComponent(BOT.did)}/switch`] = () =>
      json(200, { switch: { status: "manual", reason: "reauthorize" } });
    routes[`POST /me/bots/${encodeURIComponent(BOT.did)}/verify`] = () =>
      json(200, {
        switch: { status: "verified", verifiedAt: "2026-10-31T00:00:00.000Z" },
      });

    expect(await run(["switch", "weather"], io())).toBe(0);
    expect(stdout()).toContain("add the bot again");
    expect(await run(["verify", "@weather.bluesky.bot"], io())).toBe(0);
    expect(stdout()).toContain("✓ handle verified");
  });

  it("release asks first, and needs --yes without a terminal", async () => {
    const route = vi.fn(() =>
      json(200, {
        handle: BOT.handle,
        revert: { status: "reverted", handle: "weather.bsky.social" },
      }),
    );
    routes[`POST /me/bots/${encodeURIComponent(BOT.did)}/release`] = route;

    expect(await run(["release", "weather"], io())).toBe(2);
    expect(stderr()).toContain("--yes");

    expect(
      await run(["release", "weather"], io({ confirm: async () => false })),
    ).toBe(1);
    expect(route).not.toHaveBeenCalled();

    expect(
      await run(["release", "weather"], io({ confirm: async () => true })),
    ).toBe(0);
    expect(await run(["release", "weather", "--yes"], io())).toBe(0);
    expect(route).toHaveBeenCalledTimes(2);
    expect(stdout()).toContain("✓ the bot is back on @weather.bsky.social");
  });

  it("bots lists the creator's bots, as JSON too", async () => {
    expect(await run(["bots"], io())).toBe(0);
    expect(stdout()).toContain("weather.bluesky.bot");
    expect(stdout()).toContain("no handle yet");

    out = [];
    expect(await run(["bots", "--json"], io())).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ bots: [BOT, NEW_BOT] });
  });
});

describe("bsbot directory", () => {
  it("passes the filters and prints the next page", async () => {
    routes["GET /bots?q=wea&verified=true&limit=1"] = () =>
      json(200, {
        bots: [{ ...BOT, description: null, category: "weather" }],
        cursor: "abc",
      });

    expect(
      await run(
        ["directory", "--q", "wea", "--verified", "--limit", "1"],
        io(),
      ),
    ).toBe(0);
    expect(stdout()).toContain("weather.bluesky.bot");
    expect(stdout()).toContain("--cursor abc");
  });
});

describe("usage", () => {
  it("exits 2 on an unknown command, option or missing argument", async () => {
    expect(await run(["nope"], io())).toBe(2);
    expect(await run(["--nope"], io())).toBe(2);
    expect(await run(["check"], io())).toBe(2);
    expect(await run([], io())).toBe(2);
    expect(await run(["--help"], io())).toBe(0);
  });

  it("refuses to send a token over plain http to another machine", async () => {
    expect(await run(["bots", "--api-url", "http://bluesky.bot"], io())).toBe(
      1,
    );
    expect(stderr()).toContain("use https");
  });
});

describe("findBot", () => {
  const bots = [BOT, NEW_BOT];

  it("matches a DID, a handle, a name or a previous handle", () => {
    expect(findBot(bots, BOT.did)).toBe(BOT);
    expect(findBot(bots, "Weather.Bluesky.Bot")).toBe(BOT);
    expect(findBot(bots, "@weather.bluesky.bot")).toBe(BOT);
    expect(findBot(bots, "weather")).toBe(BOT);
    expect(findBot(bots, "news.bsky.social")).toBe(NEW_BOT);
  });

  it("refuses an unknown or ambiguous bot", () => {
    expect(() => findBot(bots, "other")).toThrow(/No bot/);
    const twin = {
      ...NEW_BOT,
      did: "did:plc:twin",
      previousHandle: "weather.bluesky.bot",
    };
    expect(() => findBot([BOT, twin], "weather.bluesky.bot")).toThrow(
      /several/,
    );
  });
});

const enc = encodeURIComponent;

function checkup(overrides: Partial<Checkup["summary"]> = {}): Checkup {
  const summary = { passed: 5, total: 6, fail: 0, warn: 1, ...overrides };
  return {
    bot: { did: BOT.did, handle: BOT.handle },
    checkedAt: "2026-11-15T00:00:00.000Z",
    summary,
    checks: [
      {
        id: "automation_label",
        status: summary.fail ? "fail" : "pass",
        message: summary.fail
          ? "Bluesky does not show the Automation label."
          : "Bluesky shows the Automation label.",
        fixUrl: summary.fail
          ? "https://bluesky.bot/docs/best-practices#say-it-is-a-bot"
          : null,
        docsUrl: null,
      },
      {
        id: "operator",
        status: "warn",
        message: "No operator line.",
        fixUrl: "https://bluesky.bot/manage/bots/1?tab=directory",
        docsUrl: null,
      },
      {
        id: "listed",
        status: "info",
        message: "Listed in the directory.",
        fixUrl: null,
        docsUrl: null,
      },
      // A check this version does not know, with a future status.
      {
        id: "brand_new_check",
        status: "skipped",
        message: "A new check.",
        fixUrl: null,
        docsUrl: null,
      },
    ],
  };
}

describe("bsbot doctor", () => {
  beforeEach(signIn);

  it("prints the checkup of one bot, found by name", async () => {
    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () => json(200, checkup());

    expect(await run(["doctor", "weather"], io())).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([
      `${API}/api/v1/me/bots`,
      `${API}/api/v1/me/bots/${enc(BOT.did)}/doctor`,
    ]);
    expect(stdout()).toContain("weather.bluesky.bot  5/6  1 suggestion");
    expect(stdout()).toContain("✓ Bluesky shows the Automation label.");
    expect(stdout()).toContain("! No operator line.");
    expect(stdout()).toContain("fix:  https://bluesky.bot/manage/bots/1");
    expect(stdout()).toContain("· Listed in the directory.");
    expect(stdout()).toContain("? A new check.");
    expect(stdout()).not.toContain("\u001b[");
  });

  it("takes a DID without listing the bots", async () => {
    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () => json(200, checkup());

    expect(await run(["doctor", BOT.did], io())).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("exits 3 when a check fails, or warns with --strict", async () => {
    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () =>
      json(200, checkup({ passed: 4, fail: 1 }));
    expect(await run(["doctor", "weather"], io())).toBe(3);
    expect(stdout()).toContain("1 to fix, 1 suggestion");
    expect(stdout()).toContain("✗ Bluesky does not show the Automation label.");

    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () => json(200, checkup());
    expect(await run(["doctor", "weather", "--strict"], io())).toBe(3);
  });

  it("prints the API document as is with --json", async () => {
    const body = checkup({ passed: 4, fail: 1 });
    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () => json(200, body);

    expect(await run(["doctor", "weather", "--json"], io())).toBe(3);
    expect(JSON.parse(stdout())).toEqual(body);
  });

  it("colours the marks on a terminal, unless NO_COLOR", async () => {
    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () => json(200, checkup());

    await run(["doctor", "weather"], io({ color: true }));
    expect(stdout()).toContain("\u001b[32m✓\u001b[0m");

    out = [];
    const noColor = io({ color: true });
    noColor.env.NO_COLOR = "1";
    await run(["doctor", "weather"], noColor);
    expect(stdout()).not.toContain("\u001b[");
  });

  it("reports 401, 403, 404 and 429 with the server's message", async () => {
    const doctor = `GET /me/bots/${enc(BOT.did)}/doctor`;
    routes[doctor] = () =>
      json(403, {
        error: {
          code: "forbidden",
          message: "This bot is suspended.",
          reason: "suspended",
        },
      });
    expect(await run(["doctor", BOT.did], io())).toBe(1);
    expect(stderr()).toContain("This bot is suspended.");

    err = [];
    routes[doctor] = () =>
      json(404, {
        error: {
          code: "not_found",
          message: "No bot with this DID in your account.",
        },
      });
    expect(await run(["doctor", BOT.did], io())).toBe(1);
    expect(stderr()).toContain("No bot with this DID");

    err = [];
    routes[doctor] = () =>
      json(429, {
        error: {
          code: "rate_limited",
          message: "Too many checkups.",
          retryAfterSeconds: 12,
        },
      });
    expect(await run(["doctor", BOT.did, "--json"], io())).toBe(1);
    expect(JSON.parse(stderr())).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many checkups. (retry in 12 s)",
      },
    });

    err = [];
    routes[doctor] = () =>
      json(401, { error: { code: "unauthorized", message: "Expired." } });
    expect(await run(["doctor", BOT.did], io())).toBe(1);
    expect(stderr()).toContain("Expired. Run `bsbot login`.");
  });

  it("checks every bot without <bot>, skipping the suspended ones", async () => {
    const suspended = {
      ...NEW_BOT,
      did: "did:plc:suspended",
      status: "suspended" as const,
    };
    routes["GET /me/bots"] = () =>
      json(200, { bots: [BOT, NEW_BOT, suspended] });
    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () => json(200, checkup());
    routes[`GET /me/bots/${enc(NEW_BOT.did)}/doctor`] = () =>
      json(200, {
        ...checkup({ passed: 3, fail: 2 }),
        bot: { did: NEW_BOT.did, handle: null },
      });

    expect(await run(["doctor"], io())).toBe(3);
    const lines = stdout().trim().split("\n");
    expect(lines[0]).toMatch(/^weather\.bluesky\.bot\s+5\/6  1 suggestion$/);
    expect(lines[1]).toMatch(/^news\.bsky\.social\s+3\/6  2 to fix/);
    expect(lines[2]).toBe("(1 suspended bot skipped)");
    expect(calls.some((call) => call.url.includes("suspended"))).toBe(false);

    out = [];
    expect(await run(["doctor", "--verbose"], io())).toBe(3);
    expect(stdout()).toContain("  ! No operator line.");

    out = [];
    expect(await run(["doctor", "--json"], io())).toBe(3);
    expect(JSON.parse(stdout()).bots).toHaveLength(2);
  });

  it("waits out a short Retry-After, then checks the bot again", async () => {
    routes["GET /me/bots"] = () => json(200, { bots: [BOT] });
    let tries = 0;
    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () =>
      ++tries === 1
        ? json(429, {
            error: {
              code: "rate_limited",
              message: "Too many checkups.",
              retryAfterSeconds: 2,
            },
          })
        : json(200, checkup());
    const sleep = vi.fn(async () => {});

    expect(await run(["doctor"], io({ sleep }))).toBe(0);
    expect(tries).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThan(0);
  });

  it("stops on a long Retry-After, naming the bots left", async () => {
    routes[`GET /me/bots/${enc(BOT.did)}/doctor`] = () =>
      json(429, {
        error: {
          code: "rate_limited",
          message: "Too many checkups.",
          retryAfterSeconds: 1800,
        },
      });
    routes[`GET /me/bots/${enc(NEW_BOT.did)}/doctor`] = () =>
      json(200, checkup());
    const sleep = vi.fn(async () => {});

    expect(await run(["doctor"], io({ sleep }))).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(stderr()).toContain("Not checked: weather.bluesky.bot");
    expect(stderr()).toContain("(retry in 1800 s)");
  });

  it("says when there is no bot", async () => {
    routes["GET /me/bots"] = () => json(200, { bots: [] });
    expect(await run(["doctor"], io())).toBe(0);
    expect(stdout()).toContain("No bot yet");
  });
});

const LISTING: BotListing = {
  listed: true,
  category: "weather",
  description: "Hourly weather for Paris.",
  languages: ["fr", "en"],
  showRecentPosts: true,
  operator: { name: "Météo Lab", shown: true },
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

describe("bsbot listing", () => {
  const listingPath = `/me/bots/${enc(BOT.did)}/listing`;
  let patch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await signIn();
    routes[`GET ${listingPath}`] = () => json(200, { listing: LISTING });
    patch = vi.fn((body: unknown) =>
      json(200, {
        listing: { ...LISTING, ...(body as object) },
        changed: true,
      }),
    );
    routes[`PATCH ${listingPath}`] = patch as unknown as (
      body: unknown,
    ) => Response;
  });

  const patches = () => calls.filter((call) => call.method === "PATCH");

  it("get prints the listing, as JSON too", async () => {
    expect(await run(["listing", "get", "weather"], io())).toBe(0);
    expect(stdout()).toContain("Hourly weather for Paris.");
    expect(stdout()).toContain("Météo Lab (shown)");

    out = [];
    expect(await run(["listing", "get", BOT.did, "--json"], io())).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ listing: LISTING });
  });

  it("set sends only the fields that differ, and prints what changed", async () => {
    expect(
      await run(
        [
          "listing",
          "set",
          "weather",
          "--listed",
          "--description",
          "Weather for Lyon.",
          "--operator-hidden",
          "--languages",
          "fr,en",
        ],
        io(),
      ),
    ).toBe(0);
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.body).toEqual({
      description: "Weather for Lyon.",
      operator: { shown: false },
    });
    expect(patches()[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(stdout()).toContain(
      'description: "Hourly weather for Paris." → "Weather for Lyon."',
    );
    expect(stdout()).toContain("operator.shown: true → false");
    expect(stdout()).toContain("✓ listing updated");
  });

  it("set sends nothing when nothing changes", async () => {
    expect(
      await run(
        ["listing", "set", "weather", "--listed", "--category", "weather"],
        io(),
      ),
    ).toBe(0);
    expect(patches()).toEqual([]);
    expect(stdout()).toBe("No change.\n");

    out = [];
    expect(
      await run(["listing", "set", "weather", "--listed", "--json"], io()),
    ).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      listing: LISTING,
      changed: false,
      patch: {},
    });
  });

  it("set clears a field with an empty value", async () => {
    expect(
      await run(["listing", "set", "weather", "--description", ""], io()),
    ).toBe(0);
    expect(patches()[0]?.body).toEqual({ description: null });

    calls = [];
    expect(
      await run(["listing", "set", "weather", "--support-url", ""], io()),
    ).toBe(0);
    expect(patches()).toEqual([]);
  });

  it("set reads --file, with the flags on top, and gives JSON", async () => {
    const file = path.join(root, "listing.json");
    await writeFile(
      file,
      JSON.stringify({
        ...LISTING,
        description: "From the file.",
        operator: { name: "Météo Lab", shown: true },
        disclosure: { ...LISTING.disclosure, usesGenerativeAi: false },
      }),
    );

    expect(
      await run(
        [
          "listing",
          "set",
          "weather",
          "--file",
          file,
          "--operator-hidden",
          "--json",
        ],
        io(),
      ),
    ).toBe(0);
    expect(patches()[0]?.body).toEqual({
      description: "From the file.",
      operator: { shown: false },
      disclosure: { usesGenerativeAi: false },
    });
    const body = JSON.parse(stdout());
    expect(body.changed).toBe(true);
    expect(body.patch).toEqual(patches()[0]?.body);
  });

  it("set refuses an unknown field of --file before any request", async () => {
    const file = path.join(root, "listing.json");
    await writeFile(file, JSON.stringify({ operator: { visible: true } }));

    expect(
      await run(["listing", "set", "weather", "--file", file, "--json"], io()),
    ).toBe(2);
    expect(JSON.parse(stderr())).toEqual({
      error: { code: "usage", message: "Unknown field `operator.visible`." },
    });
    expect(calls).toEqual([]);
  });

  it("set refuses nothing to set, opposite flags and a missing bot", async () => {
    expect(await run(["listing", "set", "weather"], io())).toBe(2);
    expect(stderr()).toContain("Nothing to set");
    expect(
      await run(["listing", "set", "weather", "--listed", "--unlisted"], io()),
    ).toBe(2);
    expect(await run(["listing", "set", "--listed"], io())).toBe(2);
    expect(await run(["listing"], io())).toBe(2);
    expect(await run(["listing", "show", "weather"], io())).toBe(2);
    expect(calls).toEqual([]);
  });

  it("set --dry-run prints the difference and sends nothing", async () => {
    expect(
      await run(["listing", "set", "weather", "--unlisted", "--dry-run"], io()),
    ).toBe(0);
    expect(stdout()).toContain("listed: true → false");
    expect(stdout()).toContain("Dry run");
    expect(patches()).toEqual([]);
  });

  it("set says when the server kept the stored values", async () => {
    routes[`PATCH ${listingPath}`] = () =>
      json(200, { listing: LISTING, changed: false });
    expect(
      await run(
        ["listing", "set", "weather", "--source-url", "github.com/acme/x"],
        io(),
      ),
    ).toBe(0);
    expect(stdout()).toContain("No change: the server already had");
  });

  it("set prints the field and the reason of invalid_listing", async () => {
    routes[`PATCH ${listingPath}`] = () =>
      json(400, {
        error: {
          code: "invalid_listing",
          message: "`description` is refused (link). Nothing was saved.",
          field: "description",
          reason: "link",
        },
      });

    const args = ["listing", "set", "weather", "--description", "https://x.y"];
    expect(await run(args, io())).toBe(1);
    expect(stderr()).toContain("✗ `description` is refused (link).");
    expect(stderr()).toContain("  field: description\n  reason: link\n");

    err = [];
    expect(await run([...args, "--json"], io())).toBe(1);
    expect(JSON.parse(stderr())).toEqual({
      error: {
        code: "invalid_listing",
        message: "`description` is refused (link). Nothing was saved.",
        field: "description",
        reason: "link",
      },
    });
  });

  it("tells an old token to log in again on 403 insufficient_scope", async () => {
    routes[`GET ${listingPath}`] = () =>
      json(403, {
        error: {
          code: "insufficient_scope",
          message: "This token cannot edit listings. Run `bsbot login` again.",
          scope: "listing",
        },
      });
    expect(await run(["listing", "get", "weather"], io())).toBe(1);
    expect(stderr()).toBe(
      "✗ This token cannot edit listings. Run `bsbot login` again.\n",
    );

    // An older wording without the fix gets it added.
    err = [];
    routes[`GET ${listingPath}`] = () =>
      json(403, {
        error: {
          code: "insufficient_scope",
          message: "Missing scope.",
          scope: "listing",
        },
      });
    expect(await run(["listing", "get", "weather", "--json"], io())).toBe(1);
    expect(JSON.parse(stderr())).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Missing scope. Run `bsbot login` again for a token that can.",
        scope: "listing",
      },
    });
  });

  it("asks for the DID when the token cannot list the bots", async () => {
    routes["GET /me/bots"] = () =>
      json(403, {
        error: {
          code: "insufficient_scope",
          message: "This token cannot manage handles.",
          scope: "handles",
        },
      });
    expect(await run(["listing", "get", "weather"], io())).toBe(2);
    expect(stderr()).toContain("give the bot's DID");

    expect(await run(["listing", "get", BOT.did], io())).toBe(0);
  });

  it("reports 401, 404 and 429", async () => {
    routes[`PATCH ${listingPath}`] = () =>
      json(429, {
        error: {
          code: "rate_limited",
          message: "Too many listing changes.",
          retryAfterSeconds: 60,
        },
      });
    expect(await run(["listing", "set", "weather", "--unlisted"], io())).toBe(
      1,
    );
    expect(stderr()).toContain("Too many listing changes. (retry in 60 s)");

    err = [];
    expect(await run(["listing", "get", "did:plc:notmine"], io())).toBe(1);
    expect(stderr()).toContain("✗ No.");

    err = [];
    routes[`GET ${listingPath}`] = () =>
      json(401, { error: { code: "unauthorized", message: "Revoked." } });
    expect(await run(["listing", "get", BOT.did], io())).toBe(1);
    expect(stderr()).toContain("Revoked. Run `bsbot login`.");
  });
});

describe("whoami and the token's scopes", () => {
  const me = (token: Record<string, unknown>) => () =>
    json(200, {
      creator: { did: DID, handle: "alice.test", displayName: null },
      token: {
        name: "laptop",
        createdAt: "2026-10-31T00:00:00.000Z",
        expiresAt: "2026-11-30T00:00:00.000Z",
        ...token,
      },
    });

  beforeEach(signIn);

  it("shows the scopes and the bound bot when the server sends them", async () => {
    routes["GET /me"] = me({ scopes: ["handles", "listing"], botDid: BOT.did });
    expect(await run(["whoami"], io())).toBe(0);
    expect(stdout()).toContain("scopes: handles, listing");
    expect(stdout()).toContain(`only for the bot ${BOT.did}`);
    expect(stdout()).not.toContain("run `bsbot login` again");

    out = [];
    expect(await run(["whoami", "--json"], io())).toBe(0);
    expect(JSON.parse(stdout()).token).toMatchObject({
      scopes: ["handles", "listing"],
      botDid: BOT.did,
    });
  });

  it("tells a token without the listing scope to log in again", async () => {
    routes["GET /me"] = me({ scopes: ["handles"], botDid: null });
    expect(await run(["whoami"], io())).toBe(0);
    expect(stdout()).toContain("scopes: handles\n");
    expect(stdout()).toContain("run `bsbot login` again");
    expect(stdout()).not.toContain("only for the bot");
  });

  it("works with an older server that sends neither", async () => {
    routes["GET /me"] = me({});
    expect(await run(["whoami"], io())).toBe(0);
    expect(stdout()).not.toContain("scopes");
  });
});

describe("BSBOT_TOKEN", () => {
  const ENV_TOKEN = "bsbot_env-token-for-tests-only";
  const withToken = (token: string, overrides: Partial<Io> = {}) => {
    const value = io(overrides);
    value.env.BSBOT_TOKEN = token;
    return value;
  };

  it("is used without a credentials file, and never printed", async () => {
    expect(await run(["bots", "--json"], withToken(ENV_TOKEN))).toBe(0);
    expect(calls[0]?.auth).toBe(`Bearer ${ENV_TOKEN}`);
    expect(stdout() + stderr()).not.toContain(ENV_TOKEN);
  });

  it("wins over the saved token", async () => {
    await signIn();
    expect(await run(["bots"], withToken(` ${ENV_TOKEN}\n`))).toBe(0);
    expect(calls[0]?.auth).toBe(`Bearer ${ENV_TOKEN}`);
  });

  it("refuses a value that is not a token", async () => {
    expect(await run(["bots"], withToken("not a token"))).toBe(2);
    expect(stderr()).toContain("BSBOT_TOKEN does not look like");
    expect(stderr()).not.toContain("not a token");
    expect(calls).toEqual([]);
  });

  it("names itself when the server refuses it", async () => {
    routes["GET /me/bots"] = () =>
      json(401, { error: { code: "unauthorized", message: "Revoked." } });
    expect(await run(["bots"], withToken(ENV_TOKEN))).toBe(1);
    expect(stderr()).toContain("(The token comes from BSBOT_TOKEN.)");
  });

  it("is shown by whoami", async () => {
    routes["GET /me"] = () =>
      json(200, {
        creator: { did: DID, handle: "alice.test" },
        token: {
          name: "ci",
          createdAt: "2026-10-31T00:00:00.000Z",
          expiresAt: "2026-11-30T00:00:00.000Z",
        },
      });
    expect(await run(["whoami"], withToken(ENV_TOKEN))).toBe(0);
    expect(stdout()).toContain("(from BSBOT_TOKEN)");
  });
});

describe("bsbot tool", () => {
  const answer = {
    tool: "tid-decoder",
    url: "https://bluesky.bot/tools/tid-decoder",
    result: { tid: "3jzfcijpj2z2a", timestamp: "2023-06-30T15:03:01.887Z" },
  };

  beforeEach(() => {
    routes["GET /tools/tid-decoder?tid=3jzfcijpj2z2a"] = () =>
      json(200, answer);
  });

  it("lists the tools of the API", async () => {
    routes["GET /openapi.json"] = () =>
      json(200, {
        paths: {
          "/bots": { get: { summary: "Directory" } },
          "/tools/tid-decoder": { get: { summary: "TID decoder" } },
          "/tools/whois": { get: { summary: "Whois" } },
        },
      });
    expect(await run(["tool"], io())).toBe(0);
    expect(stdout()).toMatch(/tid-decoder\s+TID decoder/);
    expect(stdout()).not.toContain("Directory");

    out = [];
    expect(await run(["tool", "--json"], io())).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      tools: [
        { slug: "tid-decoder", title: "TID decoder" },
        { slug: "whois", title: "Whois" },
      ],
    });
  });

  it("runs a tool anonymously when signed out", async () => {
    expect(await run(["tool", "tid-decoder", "tid=3jzfcijpj2z2a"], io())).toBe(
      0,
    );
    expect(calls[0]?.auth).toBeNull();
    expect(stdout()).toContain('"timestamp": "2023-06-30T15:03:01.887Z"');
    expect(stdout()).toContain("https://bluesky.bot/tools/tid-decoder");

    out = [];
    await run(["tool", "tid-decoder", "tid=3jzfcijpj2z2a", "--json"], io());
    expect(JSON.parse(stdout())).toEqual(answer);
  });

  it("sends the token of this server for higher limits, never another's", async () => {
    await signIn();
    await run(["tool", "tid-decoder", "tid=3jzfcijpj2z2a"], io());
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);

    await writeCredentials(io().env, {
      version: 1,
      apiUrl: "http://localhost:3000",
      token: TOKEN,
      did: DID,
      handle: "alice.test",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    calls = [];
    await run(["tool", "tid-decoder", "tid=3jzfcijpj2z2a"], io());
    expect(calls[0]?.auth).toBeNull();
  });

  it("encodes the parameters, keeping = in values", async () => {
    routes["GET /tools/character-counter?text=a%3Db+c&numbered=false"] = () =>
      json(200, { ...answer, tool: "character-counter" });
    expect(
      await run(
        ["tool", "character-counter", "text=a=b c", "numbered=false"],
        io(),
      ),
    ).toBe(0);
  });

  it("refuses a bad name or parameter, and reports the API's errors", async () => {
    expect(await run(["tool", "../me"], io())).toBe(2);
    expect(await run(["tool", "tid-decoder", "3jzfcijpj2z2a"], io())).toBe(2);
    expect(calls).toEqual([]);

    expect(await run(["tool", "nope"], io())).toBe(1);
    expect(stderr()).toContain("✗ No.");

    err = [];
    routes["GET /tools/tid-decoder?tid=x"] = () =>
      json(400, {
        error: {
          code: "bad_request",
          message: "Not a TID.",
          parameter: "tid",
        },
      });
    expect(await run(["tool", "tid-decoder", "tid=x"], io())).toBe(1);
    expect(stderr()).toBe("✗ Not a TID.\n  parameter: tid\n");
  });
});
