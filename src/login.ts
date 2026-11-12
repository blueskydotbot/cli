// OAuth 2.0 for native apps (RFC 8252) with PKCE (RFC 7636): a loopback
// server on 127.0.0.1 receives the code, then closes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export type Pkce = { verifier: string; challenge: string };

export function newPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function authorizeUrl(
  apiUrl: string,
  params: {
    redirectUri: string;
    state: string;
    challenge: string;
    clientName: string;
  },
): string {
  const query = new URLSearchParams({
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    client_name: params.clientName,
  });
  return `${apiUrl}/cli/authorize?${query}`;
}

function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${text}</p></body></html>`;

export class LoginError extends Error {
  readonly code: "access_denied" | "timeout" | "server_error";

  constructor(code: LoginError["code"], message: string) {
    super(message);
    this.name = "LoginError";
    this.code = code;
  }
}

export type Loopback = {
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
};

// Any request without our state gets an error page and is ignored.
export async function startLoopback(
  state: string,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
): Promise<Loopback> {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The caller may stop listening: never leave an unhandled rejection.
  code.catch(() => {});

  const server: Server = createServer((request, response) => {
    const send = (status: number, title: string, text: string) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'",
        "Referrer-Policy": "no-referrer",
        Connection: "close",
      });
      response.end(PAGE(title, text));
    };

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const gotState = url.searchParams.get("state") ?? "";
    if (
      request.method !== "GET" ||
      url.pathname !== "/callback" ||
      !sameState(gotState, state)
    ) {
      send(
        400,
        "Not this login",
        "This page does not match the login in progress.",
      );
      return;
    }

    if (url.searchParams.get("error") === "access_denied") {
      send(200, "Login cancelled", "You can close this tab.");
      finish();
      reject(
        new LoginError("access_denied", "Login cancelled in the browser."),
      );
      return;
    }

    const value = url.searchParams.get("code");
    if (!value) {
      send(400, "Login failed", "The browser came back without a code.");
      finish();
      reject(
        new LoginError("server_error", "The browser came back without a code."),
      );
      return;
    }

    send(
      200,
      "Signed in",
      "The bsbot CLI is signed in. You can close this tab.",
    );
    finish();
    resolve(value);
  });

  const timer = setTimeout(() => {
    finish();
    reject(new LoginError("timeout", "Timed out waiting for the browser."));
  }, timeoutMs);
  timer.unref();

  function finish() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const { port } = server.address() as AddressInfo;

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    close: finish,
  };
}
