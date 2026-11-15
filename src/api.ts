import { readFileSync } from "node:fs";

// package.json sits one level up from both src/ and dist/.
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
export const DEFAULT_API_URL = "https://bluesky.bot";

/** The extra fields of an API error the CLI shows (`invalid_listing`…). */
export const ERROR_DETAILS = ["field", "reason", "parameter", "scope"] as const;
export type ErrorDetails = Partial<
  Record<(typeof ERROR_DETAILS)[number], string>
>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
  readonly details: ErrorDetails;

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds?: number,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }
}

// A token is only sent over https, or over http to this machine.
export function normalizeApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(0, "bad_api_url", `Not a URL: ${raw}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ApiError(
      0,
      "bad_api_url",
      `Refusing ${url.origin}: use https (http only for localhost).`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ApiError(
      0,
      "bad_api_url",
      "The API URL takes no credentials, query or fragment.",
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export type Fetch = typeof fetch;

export type SwitchOutcome =
  | { status: "verified"; verifiedAt: string }
  | { status: "pending" }
  | {
      status: "manual";
      reason: "reauthorize" | "pds_refused" | "pds_unreachable";
    };

export type RevertOutcome =
  | { status: "reverted"; handle: string }
  | {
      status: "manual";
      reason: string;
      previousHandle: string | null;
    };

export type MyBot = {
  did: string;
  handle: string | null;
  previousHandle: string | null;
  displayName: string | null;
  avatar: string | null;
  verifiedAt: string | null;
  listed: boolean;
  status: "active" | "suspended";
  selfLabeled?: boolean | null;
};

export type PublicBot = {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
  description: string | null;
  category: string | null;
  verifiedAt: string | null;
};

export type Availability = {
  name: string;
  handle: string | null;
  available: boolean;
  reason: string | null;
};

export type Me = {
  creator: { did: string; handle: string; displayName?: string | null };
  token: {
    name: string;
    createdAt: string;
    expiresAt: string;
    // Since bluesky.bot issue 284; absent from older servers.
    scopes?: string[];
    botDid?: string | null;
  };
};

/** `pass`, `warn`, `fail`, `info` or `unknown`; ids may be new. */
export type Check = {
  id: string;
  status: string;
  message: string;
  fixUrl: string | null;
  docsUrl: string | null;
};

export type Checkup = {
  bot: { did: string; handle: string | null };
  checkedAt: string;
  summary: { passed: number; total: number; fail: number; warn: number };
  checks: Check[];
};

export type UsageLine = {
  kind: string;
  description: string;
  example?: string | null;
};

export type BotListing = {
  listed: boolean;
  category: string | null;
  description: string | null;
  languages: string[];
  showRecentPosts: boolean;
  operator: { name: string | null; shown: boolean };
  usage: UsageLine[];
  sourceUrl: string | null;
  openSource: boolean;
  supportUrl: string | null;
  disclosure: {
    purpose: string | null;
    contact: string | null;
    usesGenerativeAi: boolean | null;
    automationLevel: string | null;
    activities: string[];
  };
};

/** Any subset of `BotListing`'s fields; `null` clears one. */
export type BotListingPatch = Record<string, unknown>;

export type ToolAnswer = { tool: string; url: string; result: unknown };

export type OpenApiDocument = {
  paths?: Record<string, { get?: { summary?: string } }>;
};

export type TokenGrant = {
  token: string;
  tokenType: "Bearer";
  expiresAt: string;
  creator: { did: string; handle: string };
};

export class Api {
  readonly baseUrl: string;
  readonly #fetch: Fetch;
  readonly #token: string | undefined;

  constructor(baseUrl: string, fetchImpl: Fetch = fetch, token?: string) {
    this.baseUrl = baseUrl;
    this.#fetch = fetchImpl;
    this.#token = token;
  }

  private async call<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `bsbot/${VERSION}`,
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ApiError(0, "network_error", `Cannot reach ${this.baseUrl}.`);
    }

    if (response.status === 204) return undefined as T;

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // Not JSON: handled below.
    }

    if (!response.ok) {
      const error = (
        json as {
          error?: {
            code?: unknown;
            message?: unknown;
            retryAfterSeconds?: unknown;
          } & Record<string, unknown>;
        } | null
      )?.error;
      const details: ErrorDetails = {};
      for (const key of ERROR_DETAILS) {
        const value = error?.[key];
        if (typeof value === "string") details[key] = value;
      }
      throw new ApiError(
        response.status,
        typeof error?.code === "string" ? error.code : "http_error",
        typeof error?.message === "string"
          ? error.message
          : `The server answered ${response.status}.`,
        typeof error?.retryAfterSeconds === "number"
          ? error.retryAfterSeconds
          : undefined,
        details,
      );
    }
    if (json === null) {
      throw new ApiError(
        response.status,
        "bad_response",
        "The server did not answer JSON.",
      );
    }
    return json as T;
  }

  availability(name: string) {
    return this.call<Availability>(
      "GET",
      `/handles/${encodeURIComponent(name)}/availability`,
    );
  }

  directory(query: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value);
    }
    const qs = params.toString();
    return this.call<{ bots: PublicBot[]; cursor: string | null }>(
      "GET",
      `/bots${qs ? `?${qs}` : ""}`,
    );
  }

  exchangeCode(body: {
    code: string;
    code_verifier: string;
    redirect_uri: string;
  }) {
    return this.call<TokenGrant>("POST", "/cli/token", body);
  }

  me() {
    return this.call<Me>("GET", "/me");
  }

  myBots() {
    return this.call<{ bots: MyBot[] }>("GET", "/me/bots");
  }

  claim(did: string, name: string) {
    return this.call<{ handle: string; switch: SwitchOutcome }>(
      "POST",
      `/me/bots/${encodeURIComponent(did)}/claim`,
      { name },
    );
  }

  switchHandle(did: string) {
    return this.call<{ switch: SwitchOutcome }>(
      "POST",
      `/me/bots/${encodeURIComponent(did)}/switch`,
    );
  }

  verify(did: string) {
    return this.call<{ switch: SwitchOutcome }>(
      "POST",
      `/me/bots/${encodeURIComponent(did)}/verify`,
    );
  }

  release(did: string) {
    return this.call<{ handle: string; revert: RevertOutcome }>(
      "POST",
      `/me/bots/${encodeURIComponent(did)}/release`,
    );
  }

  doctor(did: string) {
    return this.call<Checkup>(
      "GET",
      `/me/bots/${encodeURIComponent(did)}/doctor`,
    );
  }

  listing(did: string) {
    return this.call<{ listing: BotListing }>(
      "GET",
      `/me/bots/${encodeURIComponent(did)}/listing`,
    );
  }

  updateListing(did: string, patch: BotListingPatch) {
    return this.call<{ listing: BotListing; changed: boolean }>(
      "PATCH",
      `/me/bots/${encodeURIComponent(did)}/listing`,
      patch,
    );
  }

  tool(slug: string, params: Array<[string, string]>) {
    const qs = new URLSearchParams(params).toString();
    return this.call<ToolAnswer>(
      "GET",
      `/tools/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`,
    );
  }

  openApi() {
    return this.call<OpenApiDocument>("GET", "/openapi.json");
  }

  revokeToken() {
    return this.call<void>("DELETE", "/me/token");
  }
}
