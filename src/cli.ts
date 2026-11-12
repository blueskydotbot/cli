import { hostname } from "node:os";
import { parseArgs } from "node:util";
import {
  Api,
  ApiError,
  DEFAULT_API_URL,
  type Fetch,
  type MyBot,
  normalizeApiUrl,
  type RevertOutcome,
  type SwitchOutcome,
  VERSION,
} from "./api.ts";
import {
  type Credentials,
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials.ts";
import {
  authorizeUrl,
  LOGIN_TIMEOUT_MS,
  LoginError,
  newPkce,
  newState,
  startLoopback,
} from "./login.ts";

export type Io = {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: Fetch;
  openBrowser: (url: string) => void;
  confirm: ((question: string) => Promise<boolean>) | null;
  loginTimeoutMs?: number;
};

const HANDLE_SUFFIX = ".bluesky.bot";

const HELP = `bsbot ${VERSION}: manage your Bluesky bots and their name${HANDLE_SUFFIX} handles.

Usage: bsbot <command> [options]

Account
  login [--no-browser] [--name <label>]
                           Sign in through the browser (OAuth, no password);
                           <label> names this machine in your settings
  logout                   Revoke this machine's token and forget it
  whoami                   Show the signed-in account

Handles
  check <name>             Is <name>${HANDLE_SUFFIX} free to claim?
  claim <bot> <name>       Claim <name>${HANDLE_SUFFIX} for a bot and switch to it
  switch <bot>             Ask the bot's server again to use its handle
  verify <bot>             Check that the bot's handle is live on Bluesky
  release <bot> [--yes]    Give the handle up (the bot goes back to its old one)

Bots
  bots                     List your bots
  directory [--q <text>] [--category <c>] [--verified] [--limit <n>] [--cursor <c>]
                           Browse the public directory

<bot> is a bot's DID, its handle, its previous handle, or the name of its
${HANDLE_SUFFIX} handle. Add bots from the dashboard: https://bluesky.bot/manage

Options
  --json                   Machine-readable output (never contains the token)
  --api-url <url>          Another server (or BSBOT_API_URL)
  -h, --help               This help
  -v, --version            The version
`;

class UsageError extends Error {}

const OPTIONS = {
  json: { type: "boolean" },
  "api-url": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  "no-browser": { type: "boolean" },
  name: { type: "string" },
  yes: { type: "boolean", short: "y" },
  q: { type: "string" },
  category: { type: "string" },
  verified: { type: "boolean" },
  limit: { type: "string" },
  cursor: { type: "string" },
} as const;

type Values = {
  json?: boolean;
  "api-url"?: string;
  help?: boolean;
  version?: boolean;
  "no-browser"?: boolean;
  name?: string;
  yes?: boolean;
  q?: string;
  category?: string;
  verified?: boolean;
  limit?: string;
  cursor?: string;
};

type Context = {
  io: Io;
  values: Values;
  args: string[];
  apiUrl: string;
  json: boolean;
};

function print(ctx: Context, data: unknown, human: string): void {
  ctx.io.stdout(ctx.json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
}

function arg(ctx: Context, index: number, name: string): string {
  const value = ctx.args[index];
  if (!value) throw new UsageError(`Missing <${name}>. See bsbot --help.`);
  return value;
}

function date(iso: string): string {
  return iso.slice(0, 10);
}

async function signedIn(
  ctx: Context,
): Promise<{ api: Api; credentials: Credentials }> {
  const credentials = await readCredentials(ctx.io.env);
  if (!credentials) {
    throw new ApiError(
      401,
      "unauthorized",
      "Not signed in. Run `bsbot login`.",
    );
  }
  if (credentials.apiUrl !== ctx.apiUrl) {
    throw new ApiError(
      401,
      "unauthorized",
      `Signed in to ${credentials.apiUrl}, not ${ctx.apiUrl}. Run \`bsbot login\`.`,
    );
  }
  return {
    api: new Api(ctx.apiUrl, ctx.io.fetch, credentials.token),
    credentials,
  };
}

export function findBot(
  bots: MyBot[],
  query: string,
  dashboard = "https://bluesky.bot/manage",
): MyBot {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  const matches = bots.filter(
    (bot) =>
      bot.did === query.trim() ||
      bot.handle?.toLowerCase() === q ||
      bot.handle?.toLowerCase() === `${q}${HANDLE_SUFFIX}` ||
      bot.previousHandle?.toLowerCase() === q,
  );
  if (matches.length === 1) return matches[0] as MyBot;
  if (matches.length > 1) {
    throw new UsageError(`"${query}" matches several bots: use the DID.`);
  }
  throw new UsageError(
    `No bot "${query}" in your account. \`bsbot bots\` lists them; add bots at ${dashboard}.`,
  );
}

async function resolveBot(
  ctx: Context,
  api: Api,
  index: number,
): Promise<MyBot> {
  const query = arg(ctx, index, "bot");
  return findBot((await api.myBots()).bots, query, dashboardUrl(ctx));
}

function dashboardUrl(ctx: Context): string {
  return `${ctx.apiUrl}/manage`;
}

// "Pending": after a switch, the bot's server took the handle but Bluesky has
// not caught up; after a check, Bluesky does not show the handle yet.
function switchLine(
  ctx: Context,
  outcome: SwitchOutcome,
  handle: string,
  bot: string,
  after: "switch" | "verify",
): string {
  switch (outcome.status) {
    case "verified":
      return "✓ handle verified: live on Bluesky";
    case "pending":
      return after === "switch"
        ? `… ${handle} is set on the bot's server; Bluesky has not picked it up yet. Run \`bsbot verify ${bot}\` in a minute.`
        : `… Bluesky does not show ${handle} yet. Run \`bsbot verify ${bot}\` again in a minute, or \`bsbot switch ${bot}\` if it never comes.`;
    case "manual":
      return {
        reauthorize: `! Bluesky.bot cannot change this bot's handle any more: add the bot again at ${dashboardUrl(ctx)}, then run \`bsbot switch ${bot}\`.`,
        pds_refused: `! The bot's server refused ${handle}. Set it by hand in the bot's account settings.`,
        pds_unreachable: `! The bot's server did not answer. Try \`bsbot switch ${bot}\` later.`,
      }[outcome.reason];
  }
}

function revertLine(revert: RevertOutcome): string {
  return revert.status === "reverted"
    ? `✓ the bot is back on @${revert.handle}`
    : `! Change the bot's handle by hand on Bluesky${revert.previousHandle ? ` (it was @${revert.previousHandle})` : ""}.`;
}

function botLine(bot: MyBot): string {
  const name = bot.handle ?? bot.previousHandle ?? bot.did;
  const state =
    bot.status === "suspended"
      ? "suspended"
      : !bot.handle
        ? "no handle yet"
        : bot.verifiedAt
          ? "live"
          : "claimed, not live yet";
  return `${name.padEnd(36)} ${state.padEnd(22)} ${bot.listed ? "listed" : "unlisted"}  ${bot.did}`;
}

async function login(ctx: Context): Promise<number> {
  const pkce = newPkce();
  const state = newState();
  const loopback = await startLoopback(
    state,
    ctx.io.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
  );
  try {
    const url = authorizeUrl(ctx.apiUrl, {
      redirectUri: loopback.redirectUri,
      state,
      challenge: pkce.challenge,
      // What the consent page and the settings show for this token.
      clientName: (ctx.values.name?.trim() || hostname()).slice(0, 64),
    });
    // Instructions go to stderr: stdout stays clean for `--json`.
    ctx.io.stderr(
      `Open this page to sign in (it expires in ${Math.round((ctx.io.loginTimeoutMs ?? LOGIN_TIMEOUT_MS) / 60000)} minutes):\n\n  ${url}\n\n`,
    );
    if (!ctx.values["no-browser"]) ctx.io.openBrowser(url);

    const code = await loopback.code;
    const grant = await new Api(ctx.apiUrl, ctx.io.fetch).exchangeCode({
      code,
      code_verifier: pkce.verifier,
      redirect_uri: loopback.redirectUri,
    });
    const file = await writeCredentials(ctx.io.env, {
      version: 1,
      apiUrl: ctx.apiUrl,
      token: grant.token,
      did: grant.creator.did,
      handle: grant.creator.handle,
      expiresAt: grant.expiresAt,
    });
    print(
      ctx,
      { creator: grant.creator, expiresAt: grant.expiresAt, credentials: file },
      `✓ signed in as @${grant.creator.handle} (until ${date(grant.expiresAt)}; token saved in ${file})`,
    );
    return 0;
  } finally {
    loopback.close();
  }
}

async function logout(ctx: Context): Promise<number> {
  const credentials = await readCredentials(ctx.io.env);
  let revoked = false;
  if (credentials) {
    try {
      await new Api(
        credentials.apiUrl,
        ctx.io.fetch,
        credentials.token,
      ).revokeToken();
      revoked = true;
    } catch (error) {
      // Already revoked or expired: nothing left to revoke.
      revoked = error instanceof ApiError && error.status === 401;
      if (!revoked) {
        ctx.io.stderr(
          `! Could not revoke the token on ${credentials.apiUrl}; revoke it in your settings.\n`,
        );
      }
    }
  }
  await deleteCredentials(ctx.io.env);
  print(
    ctx,
    { signedOut: true, revoked },
    credentials ? "✓ signed out" : "Not signed in.",
  );
  return 0;
}

async function command(ctx: Context, name: string): Promise<number> {
  switch (name) {
    case "login":
      return login(ctx);
    case "logout":
      return logout(ctx);
    case "whoami": {
      const { api } = await signedIn(ctx);
      const me = await api.me();
      print(
        ctx,
        me,
        `@${me.creator.handle} (${me.creator.did})\ntoken "${me.token.name}", valid until ${date(me.token.expiresAt)}`,
      );
      return 0;
    }
    case "check": {
      const name = arg(ctx, 0, "name");
      const result = await new Api(ctx.apiUrl, ctx.io.fetch).availability(name);
      const handle = result.handle ?? `${result.name}${HANDLE_SUFFIX}`;
      print(
        ctx,
        result,
        result.available
          ? `✓ ${handle} is available`
          : `✗ ${handle} is not available (${result.reason})`,
      );
      return 0;
    }
    case "claim": {
      const { api } = await signedIn(ctx);
      const bot = await resolveBot(ctx, api, 0);
      const name = arg(ctx, 1, "name");
      const result = await api.claim(bot.did, name);
      print(
        ctx,
        result,
        `✓ ${result.handle} is yours\n${switchLine(ctx, result.switch, result.handle, result.handle.replace(HANDLE_SUFFIX, ""), "switch")}`,
      );
      return 0;
    }
    case "switch":
    case "verify": {
      const { api } = await signedIn(ctx);
      const bot = await resolveBot(ctx, api, 0);
      const result =
        name === "switch"
          ? await api.switchHandle(bot.did)
          : await api.verify(bot.did);
      print(
        ctx,
        result,
        switchLine(
          ctx,
          result.switch,
          bot.handle ?? "",
          ctx.args[0] ?? bot.did,
          name === "switch" ? "switch" : "verify",
        ),
      );
      return 0;
    }
    case "release": {
      const { api } = await signedIn(ctx);
      const bot = await resolveBot(ctx, api, 0);
      if (!bot.handle)
        throw new UsageError("This bot has no handle to release.");
      if (!ctx.values.yes) {
        if (!ctx.io.confirm) {
          throw new UsageError("Add --yes to release without a prompt.");
        }
        const ok = await ctx.io.confirm(
          `Release ${bot.handle}? Others cannot take it for a grace period, but you lose it. [y/N] `,
        );
        if (!ok) {
          print(ctx, { released: false }, "Nothing released.");
          return 1;
        }
      }
      const result = await api.release(bot.did);
      print(
        ctx,
        result,
        `✓ ${result.handle} released\n${revertLine(result.revert)}`,
      );
      return 0;
    }
    case "bots": {
      const { api } = await signedIn(ctx);
      const { bots } = await api.myBots();
      print(
        ctx,
        { bots },
        bots.length
          ? bots.map(botLine).join("\n")
          : `No bot yet. Add one at ${dashboardUrl(ctx)}.`,
      );
      return 0;
    }
    case "directory": {
      const page = await new Api(ctx.apiUrl, ctx.io.fetch).directory({
        q: ctx.values.q,
        category: ctx.values.category,
        verified: ctx.values.verified ? "true" : undefined,
        limit: ctx.values.limit,
        cursor: ctx.values.cursor,
      });
      const lines = page.bots.map(
        (bot) =>
          `${bot.handle.padEnd(36)} ${(bot.displayName ?? "").slice(0, 40)}${bot.category ? `  [${bot.category}]` : ""}`,
      );
      if (page.cursor)
        lines.push(`\nNext page: bsbot directory --cursor ${page.cursor}`);
      print(ctx, page, lines.length ? lines.join("\n") : "No bot found.");
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${name}". See bsbot --help.`);
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  let json = argv.includes("--json");
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }) as { values: Values; positionals: string[] };
    json = values.json === true;

    if (values.version) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    const [name, ...args] = positionals;
    if (values.help || !name) {
      io.stdout(HELP);
      return name || values.help ? 0 : 2;
    }

    const apiUrl = normalizeApiUrl(
      values["api-url"] ?? io.env.BSBOT_API_URL ?? DEFAULT_API_URL,
    );
    return await command({ io, values, args, apiUrl, json }, name);
  } catch (error) {
    const usage =
      error instanceof UsageError ||
      (error instanceof TypeError && "code" in error);
    const code =
      error instanceof ApiError
        ? error.code
        : error instanceof LoginError
          ? error.code
          : usage
            ? "usage"
            : "error";
    let message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      error.code === "unauthorized"
    ) {
      message = message.includes("bsbot login")
        ? message
        : `${message} Run \`bsbot login\`.`;
    }
    if (error instanceof ApiError && error.retryAfterSeconds) {
      message += ` (retry in ${error.retryAfterSeconds} s)`;
    }
    io.stderr(
      json
        ? `${JSON.stringify({ error: { code, message } })}\n`
        : `✗ ${message}\n`,
    );
    return usage ? 2 : 1;
  }
}

export { credentialsPath };
