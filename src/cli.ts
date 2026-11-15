import { hostname } from "node:os";
import { parseArgs } from "node:util";
import {
  Api,
  ApiError,
  type Checkup,
  DEFAULT_API_URL,
  type Fetch,
  type Me,
  type MyBot,
  normalizeApiUrl,
  type RevertOutcome,
  type SwitchOutcome,
  VERSION,
} from "./api.ts";
import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials.ts";
import {
  checkupFails,
  checkupLines,
  checkupRow,
  EXIT_CHECK_FAILED,
} from "./doctor.ts";
import { UsageError } from "./errors.ts";
import {
  type ListingFlags,
  listingFromFlags,
  listingLines,
  listingPatch,
  mergeListing,
  patchLines,
  readListingFile,
} from "./listing.ts";
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
  /** stdout is a terminal: `doctor` may colour its marks. */
  color?: boolean;
  /** Waits out a `Retry-After` (tests pass a fake one). */
  sleep?: (ms: number) => Promise<void>;
};

const HANDLE_SUFFIX = ".bluesky.bot";

const HELP = `bsbot ${VERSION}: manage your Bluesky bots and their name${HANDLE_SUFFIX} handles.

Usage: bsbot <command> [options]

Account
  login [--no-browser] [--name <label>]
                           Sign in through the browser (OAuth, no password);
                           <label> names this machine in your settings
  logout                   Revoke this machine's token and forget it
  whoami                   Show the signed-in account and the token's scopes

Handles
  check <name>             Is <name>${HANDLE_SUFFIX} free to claim?
  claim <bot> <name>       Claim <name>${HANDLE_SUFFIX} for a bot and switch to it
  switch <bot>             Ask the bot's server again to use its handle
  verify <bot>             Check that the bot's handle is live on Bluesky
  release <bot> [--yes]    Give the handle up (the bot goes back to its old one)

Bots
  bots                     List your bots
  doctor [<bot>] [--strict] [--verbose]
                           The bot's checkup (every bot without <bot>);
                           exit code 3 when a check fails (or warns, with
                           --strict)
  listing get <bot>        The bot's directory listing
  listing set <bot> [fields] [--file <listing.json>] [--dry-run]
                           Change the listing: only the fields that differ
                           are sent, nothing when none does
      --listed | --unlisted              --category <slug>
      --description <text>               --languages <code,code>
      --recent-posts | --no-recent-posts
      --operator-name <text>             --operator-shown | --operator-hidden
      --source-url <url>                 --open-source | --no-open-source
      --support-url <url>
                           An empty value ("") clears a field. --file takes
                           a JSON object of the listing's fields (any of
                           those under "listing" in \`listing get --json\`);
                           the flags win over it
  directory [--q <text>] [--category <c>] [--verified] [--limit <n>] [--cursor <c>]
                           Browse the public directory

Tools
  tool                     List the free tools of ${DEFAULT_API_URL}/tools
  tool <slug> [key=value ...]
                           Run one (sends your token when signed in, for
                           higher limits)

<bot> is a bot's DID, its handle, its previous handle, or the name of its
${HANDLE_SUFFIX} handle. Add bots from the dashboard: https://bluesky.bot/manage

Options
  --json                   Machine-readable output (never contains the token)
  --api-url <url>          Another server (or BSBOT_API_URL)
  -h, --help               This help
  -v, --version            The version

BSBOT_TOKEN, when set, is used instead of the saved token (for CI).
Exit codes: 0 done, 1 error, 2 usage mistake, 3 doctor found a check to fix.
`;

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
  strict: { type: "boolean" },
  verbose: { type: "boolean" },
  file: { type: "string" },
  "dry-run": { type: "boolean" },
  listed: { type: "boolean" },
  unlisted: { type: "boolean" },
  description: { type: "string" },
  languages: { type: "string" },
  "recent-posts": { type: "boolean" },
  "no-recent-posts": { type: "boolean" },
  "operator-name": { type: "string" },
  "operator-shown": { type: "boolean" },
  "operator-hidden": { type: "boolean" },
  "source-url": { type: "string" },
  "open-source": { type: "boolean" },
  "no-open-source": { type: "boolean" },
  "support-url": { type: "string" },
} as const;

type Values = ListingFlags & {
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
  strict?: boolean;
  verbose?: boolean;
  file?: string;
  "dry-run"?: boolean;
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

// What `Authorization: Bearer` accepts on the server.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** BSBOT_TOKEN, used instead of the credentials file (CI); never printed. */
function envToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.BSBOT_TOKEN?.trim();
  if (!token) return undefined;
  if (!TOKEN_SHAPE.test(token)) {
    throw new UsageError("BSBOT_TOKEN does not look like a bsbot token.");
  }
  return token;
}

async function signedIn(ctx: Context): Promise<{ api: Api }> {
  const token = envToken(ctx.io.env);
  if (token) return { api: new Api(ctx.apiUrl, ctx.io.fetch, token) };
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
  return { api: new Api(ctx.apiUrl, ctx.io.fetch, credentials.token) };
}

/** The token if there is one for this server, else none: public calls. */
async function maybeSignedIn(ctx: Context): Promise<Api> {
  let token = envToken(ctx.io.env);
  if (!token) {
    const credentials = await readCredentials(ctx.io.env);
    if (credentials?.apiUrl === ctx.apiUrl) token = credentials.token;
  }
  return new Api(ctx.apiUrl, ctx.io.fetch, token);
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

/**
 * The DID of `<bot>`: a DID as is (a token bound to one bot cannot list the
 * bots), anything else through the list of your bots.
 */
async function resolveDid(
  ctx: Context,
  api: Api,
  index: number,
): Promise<string> {
  const query = arg(ctx, index, "bot").trim();
  if (query.startsWith("did:")) return query;
  try {
    return (await resolveBot(ctx, api, index)).did;
  } catch (error) {
    // A token bound to one bot may not list the bots.
    if (error instanceof ApiError && error.code === "insufficient_scope") {
      throw new UsageError(
        `This token cannot list your bots: give the bot's DID instead of "${query}".`,
      );
    }
    throw error;
  }
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
    if (ctx.io.env.BSBOT_TOKEN?.trim()) {
      ctx.io.stderr(
        "! BSBOT_TOKEN is set: commands use it, not the token just saved.\n",
      );
    }
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
  if (ctx.io.env.BSBOT_TOKEN?.trim()) {
    ctx.io.stderr(
      "! BSBOT_TOKEN is still set and was not revoked: unset it, and revoke it in your settings if it leaked.\n",
    );
  }
  return 0;
}

function whoamiText(ctx: Context, me: Me): string {
  const lines = [
    `@${me.creator.handle} (${me.creator.did})`,
    `token "${me.token.name}", valid until ${date(me.token.expiresAt)}${envToken(ctx.io.env) ? " (from BSBOT_TOKEN)" : ""}`,
  ];
  const { scopes, botDid } = me.token;
  if (Array.isArray(scopes)) {
    lines.push(`scopes: ${scopes.length ? scopes.join(", ") : "none"}`);
    if (!scopes.includes("listing")) {
      lines.push(
        "! This token cannot read or change listings: run `bsbot login` again for one that can.",
      );
    }
  }
  if (typeof botDid === "string") lines.push(`only for the bot ${botDid}`);
  return lines.join("\n");
}

// A checkup waits out a 429 of at most this long, then gives up.
const MAX_RETRY_WAIT_SECONDS = 60;
const DOCTOR_CONCURRENCY = 4;

function useColor(ctx: Context): boolean {
  return Boolean(ctx.io.color) && !ctx.json && !ctx.io.env.NO_COLOR;
}

async function doctor(ctx: Context): Promise<number> {
  const { api } = await signedIn(ctx);
  const strict = ctx.values.strict === true;
  if (ctx.args[0] !== undefined) {
    const checkup = await api.doctor(await resolveDid(ctx, api, 0));
    print(ctx, checkup, checkupLines(checkup, useColor(ctx)).join("\n"));
    return checkupFails(checkup, strict) ? EXIT_CHECK_FAILED : 0;
  }

  const { bots } = await api.myBots();
  const active = bots.filter((bot) => bot.status !== "suspended");
  const results: Array<Checkup | undefined> = [];
  const sleep =
    ctx.io.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let next = 0;
  let resumeAt = 0;
  let stop: { error: unknown } | null = null;

  // At most DOCTOR_CONCURRENCY calls at a time. A 429 pauses every worker
  // for its Retry-After, then the same bot is tried again; a longer wait,
  // or a third 429 for one bot, stops the run.
  async function worker(): Promise<void> {
    while (!stop && next < active.length) {
      const index = next++;
      const bot = active[index] as MyBot;
      for (let attempt = 1; !stop; attempt++) {
        const wait = resumeAt - Date.now();
        if (wait > 0) await sleep(wait);
        if (stop) return;
        try {
          results[index] = await api.doctor(bot.did);
          break;
        } catch (error) {
          const seconds =
            error instanceof ApiError && error.status === 429
              ? error.retryAfterSeconds
              : undefined;
          if (
            seconds === undefined ||
            seconds > MAX_RETRY_WAIT_SECONDS ||
            attempt >= 3
          ) {
            stop ??= { error };
            return;
          }
          resumeAt = Math.max(resumeAt, Date.now() + seconds * 1000);
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DOCTOR_CONCURRENCY, active.length) }, worker),
  );

  const checked = active.flatMap((bot, index) => {
    const checkup = results[index];
    return checkup ? [{ bot, checkup }] : [];
  });
  const color = useColor(ctx);
  const lines = checked.flatMap(({ bot, checkup }) =>
    checkupRow(
      checkup.bot.handle ?? bot.previousHandle ?? bot.did,
      checkup,
      color,
      ctx.values.verbose === true,
    ),
  );
  const skipped = bots.length - active.length;
  if (skipped) {
    lines.push(`(${skipped} suspended bot${skipped === 1 ? "" : "s"} skipped)`);
  }
  if (!bots.length) lines.push(`No bot yet. Add one at ${dashboardUrl(ctx)}.`);
  if (ctx.json || lines.length) {
    print(
      ctx,
      { bots: checked.map(({ checkup }) => checkup) },
      lines.join("\n"),
    );
  }

  // Assigned inside the workers, which TypeScript does not follow.
  const failure = (stop as { error: unknown } | null)?.error;
  if (failure) {
    if (!(failure instanceof ApiError && failure.status === 429)) {
      throw failure;
    }
    const left = active
      .filter((_bot, index) => !results[index])
      .map((bot) => bot.handle ?? bot.previousHandle ?? bot.did);
    throw new ApiError(
      429,
      failure.code,
      `${failure.message} Not checked: ${left.join(", ")}.`,
      failure.retryAfterSeconds,
    );
  }
  return checked.some(({ checkup }) => checkupFails(checkup, strict))
    ? EXIT_CHECK_FAILED
    : 0;
}

async function listing(ctx: Context): Promise<number> {
  const action = arg(ctx, 0, "get|set");
  if (action === "get") {
    arg(ctx, 1, "bot");
    const { api } = await signedIn(ctx);
    const result = await api.listing(await resolveDid(ctx, api, 1));
    print(ctx, result, listingLines(result.listing).join("\n"));
    return 0;
  }
  if (action !== "set") {
    throw new UsageError(
      `Unknown command "listing ${action}": use \`listing get\` or \`listing set\`.`,
    );
  }

  // Everything local first: a mistake costs no request.
  arg(ctx, 1, "bot");
  const file = ctx.values.file ? await readListingFile(ctx.values.file) : {};
  const wanted = mergeListing(file, listingFromFlags(ctx.values));
  if (Object.keys(wanted).length === 0) {
    throw new UsageError(
      "Nothing to set: give a field (see bsbot --help) or --file.",
    );
  }

  const { api } = await signedIn(ctx);
  const did = await resolveDid(ctx, api, 1);
  const { listing: current } = await api.listing(did);
  const patch = listingPatch(current, wanted);
  if (Object.keys(patch).length === 0) {
    print(ctx, { listing: current, changed: false, patch }, "No change.");
    return 0;
  }
  const diff = patchLines(current, patch).join("\n");
  if (ctx.values["dry-run"]) {
    print(
      ctx,
      { listing: current, changed: false, patch, dryRun: true },
      `${diff}\nDry run: nothing sent.`,
    );
    return 0;
  }
  // Every PATCH counts against the server's limit, so only real changes go.
  const result = await api.updateListing(did, patch);
  print(
    ctx,
    { ...result, patch },
    `${diff}\n${result.changed ? "✓ listing updated" : "No change: the server already had these values."}`,
  );
  return 0;
}

const TOOL_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function tool(ctx: Context): Promise<number> {
  const slug = ctx.args[0];
  if (slug === undefined) {
    const doc = await new Api(ctx.apiUrl, ctx.io.fetch).openApi();
    const tools = Object.entries(doc.paths ?? {}).flatMap(([path, item]) => {
      const match = /^\/tools\/([a-z0-9-]+)$/.exec(path);
      return match
        ? [{ slug: match[1] as string, title: item.get?.summary ?? "" }]
        : [];
    });
    print(
      ctx,
      { tools },
      tools.length
        ? `${tools.map((t) => `${t.slug.padEnd(28)} ${t.title}`).join("\n")}\n\nRun one: bsbot tool <slug> key=value ...  (docs: ${ctx.apiUrl}/docs/tools-api)`
        : "No tool found.",
    );
    return 0;
  }
  if (!TOOL_SLUG.test(slug))
    throw new UsageError(`Not a tool name: "${slug}".`);
  const params = ctx.args.slice(1).map((pair): [string, string] => {
    const at = pair.indexOf("=");
    if (at < 1) {
      throw new UsageError(
        `Parameters are key=value, not "${pair}". See bsbot tool for the tools.`,
      );
    }
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
  const answer = await (await maybeSignedIn(ctx)).tool(slug, params);
  print(
    ctx,
    answer,
    `${JSON.stringify(answer.result, null, 2)}\n\n${answer.url}`,
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
      print(ctx, me, whoamiText(ctx, me));
      return 0;
    }
    case "doctor":
      return doctor(ctx);
    case "listing":
      return listing(ctx);
    case "tool":
      return tool(ctx);
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
      if (io.env.BSBOT_TOKEN?.trim()) {
        message += " (The token comes from BSBOT_TOKEN.)";
      }
    }
    // A token from before a scope existed: the server's message, which
    // names the fix, and the fix in case an older server's does not.
    if (
      error instanceof ApiError &&
      error.status === 403 &&
      error.code === "insufficient_scope" &&
      !message.includes("bsbot login")
    ) {
      message += " Run `bsbot login` again for a token that can.";
    }
    if (error instanceof ApiError && error.retryAfterSeconds) {
      message += ` (retry in ${error.retryAfterSeconds} s)`;
    }
    const details = error instanceof ApiError ? error.details : {};
    const shown = (["field", "reason", "parameter"] as const).filter(
      (key) =>
        details[key] !== undefined && (key !== "reason" || details.field),
    );
    io.stderr(
      json
        ? `${JSON.stringify({ error: { code, message, ...details } })}\n`
        : `✗ ${message}\n${shown.map((key) => `  ${key}: ${details[key]}\n`).join("")}`,
    );
    return usage ? 2 : 1;
  }
}

export { credentialsPath };
