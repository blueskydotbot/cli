import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  LoginError,
  newPkce,
  newState,
  startLoopback,
} from "./login.ts";

describe("PKCE and state", () => {
  it("gives a S256 challenge of a 43-character verifier", () => {
    const { verifier, challenge } = newPkce();

    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(newPkce().verifier).not.toBe(verifier);
  });

  it("gives an unguessable state the server accepts", () => {
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newState()).not.toBe(newState());
  });

  it("builds the /cli/authorize URL", () => {
    const url = new URL(
      authorizeUrl("https://bluesky.bot", {
        redirectUri: "http://127.0.0.1:5000/callback",
        state: "s".repeat(32),
        challenge: "c".repeat(43),
        clientName: "laptop",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://bluesky.bot/cli/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: "http://127.0.0.1:5000/callback",
      state: "s".repeat(32),
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      client_name: "laptop",
    });
  });
});

describe("the loopback server", () => {
  it("listens on 127.0.0.1 only, and takes the code that carries our state", async () => {
    const state = newState();
    const loopback = await startLoopback(state);
    expect(loopback.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );

    // Another state, another path or another method: refused, still waiting.
    const base = loopback.redirectUri;
    expect((await fetch(`${base}?code=evil&state=${newState()}`)).status).toBe(
      400,
    );
    expect(
      (
        await fetch(
          `${base.replace("/callback", "/other")}?code=x&state=${state}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}?code=x&state=${state}`, { method: "POST" })).status,
    ).toBe(400);

    const page = await fetch(`${base}?code=the-code&state=${state}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    await expect(loopback.code).resolves.toBe("the-code");

    // Closed after the first match.
    await expect(fetch(`${base}?code=again&state=${state}`)).rejects.toThrow();
  });

  it("reports a cancellation in the browser", async () => {
    const state = newState();
    const loopback = await startLoopback(state);
    await fetch(`${loopback.redirectUri}?error=access_denied&state=${state}`);

    await expect(loopback.code).rejects.toMatchObject({
      code: "access_denied",
    });
  });

  it("gives up after the timeout", async () => {
    const loopback = await startLoopback(newState(), 50);

    await expect(loopback.code).rejects.toBeInstanceOf(LoginError);
    await expect(loopback.code).rejects.toMatchObject({ code: "timeout" });
  });
});
