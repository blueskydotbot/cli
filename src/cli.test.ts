import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyBot } from "./api.ts";
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
