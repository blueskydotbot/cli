import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Api, ApiError, normalizeApiUrl, VERSION } from "./api.ts";

describe("VERSION", () => {
  it("is the version of package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  });
});

describe("normalizeApiUrl", () => {
  it("accepts https, and http only for this machine", () => {
    expect(normalizeApiUrl("https://bluesky.bot/")).toBe("https://bluesky.bot");
    expect(normalizeApiUrl("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeApiUrl("http://127.0.0.1:3100/")).toBe(
      "http://127.0.0.1:3100",
    );
    expect(normalizeApiUrl("http://[::1]:3100")).toBe("http://[::1]:3100");
  });

  it("refuses anything that could leak the token", () => {
    for (const url of [
      "http://bluesky.bot",
      "http://localhost.evil.example",
      "ftp://bluesky.bot",
      "https://user:pass@bluesky.bot",
      "https://bluesky.bot/?x=1",
      "not a url",
    ]) {
      expect(() => normalizeApiUrl(url), url).toThrow(ApiError);
    }
  });
});

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("Api", () => {
  it("sends the token as a bearer, and refuses redirects", async () => {
    const fetch = vi.fn(async () => json(200, { bots: [] }));
    await new Api("https://bluesky.bot", fetch, "bsbot_abc").myBots();

    expect(fetch).toHaveBeenCalledWith(
      "https://bluesky.bot/api/v1/me/bots",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer bsbot_abc" }),
      }),
    );
  });

  it("never sends a token on public calls", async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        name: "x",
        handle: null,
        available: false,
        reason: "too_short",
      }),
    );
    await new Api("https://bluesky.bot", fetch).availability("x");

    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("encodes the DID in the path and the name in the body", async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        handle: "weather.bluesky.bot",
        switch: { status: "pending" },
      }),
    );
    await new Api("https://bluesky.bot", fetch, "bsbot_abc").claim(
      "did:plc:abc",
      "weather",
    );

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://bluesky.bot/api/v1/me/bots/did%3Aplc%3Aabc/claim",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"weather"}');
  });

  it("turns the API's errors into ApiError, with Retry-After", async () => {
    const fetch = vi.fn(async () =>
      json(429, {
        error: {
          code: "rate_limited",
          message: "Too many.",
          retryAfterSeconds: 12,
        },
      }),
    );
    const error = await new Api("https://bluesky.bot", fetch, "t")
      .me()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "Too many.",
      retryAfterSeconds: 12,
    });
  });

  it("reports an unreachable server and a non-JSON answer", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      new Api("https://bluesky.bot", down).me(),
    ).rejects.toMatchObject({
      code: "network_error",
    });

    const html = vi.fn(async () => new Response("<html>", { status: 502 }));
    await expect(
      new Api("https://bluesky.bot", html).me(),
    ).rejects.toMatchObject({
      status: 502,
      code: "http_error",
    });
  });

  it("accepts an empty 204", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      new Api("https://bluesky.bot", fetch, "t").revokeToken(),
    ).resolves.toBeUndefined();
  });
});
