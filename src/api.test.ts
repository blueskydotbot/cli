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

  it("sends a listing patch as JSON, with the User-Agent", async () => {
    const fetch = vi.fn(async () =>
      json(200, { listing: { listed: false }, changed: true }),
    );
    await new Api("https://bluesky.bot", fetch, "t").updateListing(
      "did:plc:abc",
      { listed: false },
    );

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://bluesky.bot/api/v1/me/bots/did%3Aplc%3Aabc/listing",
    );
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe('{"listed":false}');
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "User-Agent": `bsbot/${VERSION}`,
    });
  });

  it("keeps the details of an error: field, reason, parameter, scope", async () => {
    const fetch = vi.fn(async () =>
      json(400, {
        error: {
          code: "invalid_listing",
          message: "Refused.",
          field: "usage[1].example",
          reason: "mention",
          other: "ignored",
          scope: 3,
        },
      }),
    );
    const error = await new Api("https://bluesky.bot", fetch, "t")
      .updateListing("did:plc:abc", {})
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      status: 400,
      code: "invalid_listing",
      details: { field: "usage[1].example", reason: "mention" },
    });
    expect((error as ApiError).details).not.toHaveProperty("scope");
  });

  it("puts a tool's parameters in the query string", async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        tool: "whois",
        url: "https://bluesky.bot/tools/whois",
        result: {},
      }),
    );
    await new Api("https://bluesky.bot", fetch).tool("whois", [
      ["q", "bsky.app & co"],
    ]);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://bluesky.bot/api/v1/tools/whois?q=bsky.app+%26+co",
    );
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("accepts an empty 204", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      new Api("https://bluesky.bot", fetch, "t").revokeToken(),
    ).resolves.toBeUndefined();
  });
});
