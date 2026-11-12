// Release helpers for the publish workflow, with no dependencies (Node.js 22+).
//
//   node scripts/announce.mjs notes <version>   prints the CHANGELOG section
//   node scripts/announce.mjs post              posts the release on Bluesky
//
// `post` reads VERSION, BLUESKY_HANDLE, BLUESKY_APP_PASSWORD and, optionally,
// BLUESKY_PDS_URL. It never fails the release: on any error it prints a
// warning, writes the outcome to the job summary and exits 0.

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const COMMAND = "bsbot";
export const DEFAULT_PDS_URL = "https://bsky.social";
export const MAX_GRAPHEMES = 300;
const MAX_LINES = 3;
const MAX_LINE_GRAPHEMES = 110;
const MIN_LINE_GRAPHEMES = 40;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const encoder = new TextEncoder();

export function graphemes(text) {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

export function graphemeLength(text) {
  return graphemes(text).length;
}

export function byteLength(text) {
  return encoder.encode(text).length;
}

/** Cuts `text` to at most `max` graphemes, at a word break when one is near. */
export function truncate(text, max) {
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  if (max < 1) return "";
  let cut = parts.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  if (space >= Math.floor((max - 1) * 0.6)) cut = cut.slice(0, space);
  return `${cut.join("").replace(/[\s,;:.\-–—(]+$/u, "")}…`;
}

/** The body of the `## [version]` section of a Keep a Changelog file. */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  return lines
    .slice(start + 1, end)
    .filter((line) => !/^\[[^\]]+\]: \S+$/.test(line))
    .join("\n")
    .trim();
}

function plain(markdown) {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The top-level bullets of a CHANGELOG section, as plain one-line text. */
export function bullets(section) {
  const items = [];
  let current = null;
  for (const line of section.split("\n")) {
    const top = /^[-*] (.*)$/.exec(line);
    if (top) {
      current = [top[1]];
      items.push(current);
    } else if (current && /^ {2,}\S/.test(line) && !/^\s+[-*] /.test(line)) {
      current.push(line.trim());
    } else {
      current = null;
    }
  }
  return items.map((parts) => plain(parts.join(" "))).filter(Boolean);
}

export function npmUrl(packageName, version) {
  return `https://www.npmjs.com/package/${packageName}/v/${version}`;
}

/** The post record (without createdAt) for a stable version. */
export function buildPost({ packageName, version, section, description }) {
  const head = `${COMMAND} v${version} is out\n\n`;
  const url = npmUrl(packageName, version);
  const tail = `\n\nnpx ${packageName}@latest\n`;
  const fixed = graphemeLength(head) + graphemeLength(tail);
  let shownUrl = url.replace(/^https:\/\/www\./, "");
  if (fixed + graphemeLength(shownUrl) > MAX_GRAPHEMES - MIN_LINE_GRAPHEMES) {
    shownUrl = "npmjs.com";
  }

  let budget = MAX_GRAPHEMES - fixed - graphemeLength(shownUrl);
  const lines = [];
  for (const item of bullets(section ?? "").slice(0, MAX_LINES)) {
    const room = budget - 2 - (lines.length > 0 ? 1 : 0);
    if (room < MIN_LINE_GRAPHEMES) break;
    const line = `• ${truncate(item, Math.min(room, MAX_LINE_GRAPHEMES))}`;
    budget -= graphemeLength(line) + (lines.length > 0 ? 1 : 0);
    lines.push(line);
  }

  const body = lines.length > 0 ? lines.join("\n") : "";
  const beforeUrl = body ? `${head}${body}${tail}` : `${head.trimEnd()}${tail}`;
  const text = `${beforeUrl}${shownUrl}`;
  const byteStart = byteLength(beforeUrl);
  return {
    text,
    facets: [
      {
        index: { byteStart, byteEnd: byteStart + byteLength(shownUrl) },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
      },
    ],
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: url,
        title: `${packageName} ${version} on npm`,
        description: truncate(
          description || lines[0]?.slice(2) || "",
          MAX_GRAPHEMES,
        ),
      },
    },
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when one of the posts already announces this version. */
export function alreadyAnnounced(records, version) {
  const pattern = new RegExp(
    `\\b${COMMAND} v${escapeRegExp(version)}(?![\\w-]|\\.\\d)`,
  );
  return records.some((record) => pattern.test(record?.value?.text ?? ""));
}

export function normalizePdsUrl(value) {
  let url;
  try {
    url = new URL(value || DEFAULT_PDS_URL);
  } catch {
    throw new Error(`Invalid PDS URL: ${value}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("The PDS URL must use https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The PDS URL must not carry credentials or a query.");
  }
  return url.origin;
}

async function xrpc(fetchImpl, pds, method, { query, body, token } = {}) {
  const url = new URL(`/xrpc/${method}`, pds);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const response = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = [data?.error, data?.message].filter(Boolean).join(": ");
    throw new Error(
      `${method} failed with HTTP ${response.status}${reason ? ` (${reason})` : ""}.`,
    );
  }
  return data;
}

export function postUrl(handle, uri) {
  const rkey = uri.split("/").pop();
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

/**
 * Posts the release unless the account already did.
 * Returns { status: "posted", url, text } or { status: "skipped" }.
 */
export async function announce({
  version,
  changelog,
  packageName,
  description,
  handle,
  password,
  pdsUrl,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  if (!STABLE_VERSION.test(version ?? "")) {
    throw new Error(`Not a stable version: ${version}`);
  }
  if (!packageName) throw new Error("The package name is missing.");
  if (!handle) throw new Error("BLUESKY_HANDLE is not set.");
  if (!password) throw new Error("BLUESKY_APP_PASSWORD is not set.");
  const pds = normalizePdsUrl(pdsUrl);

  const session = await xrpc(
    fetchImpl,
    pds,
    "com.atproto.server.createSession",
    {
      body: { identifier: handle, password },
    },
  );
  const token = session.accessJwt;
  const repo = session.did;
  if (!token || !repo) throw new Error("createSession returned no session.");

  const recent = await xrpc(fetchImpl, pds, "com.atproto.repo.listRecords", {
    query: { repo, collection: "app.bsky.feed.post", limit: 25 },
    token,
  });
  if (alreadyAnnounced(recent.records ?? [], version)) {
    return { status: "skipped" };
  }

  const post = buildPost({
    packageName,
    version,
    section: changelogSection(changelog, version),
    description,
  });
  const created = await xrpc(fetchImpl, pds, "com.atproto.repo.createRecord", {
    body: {
      repo,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        ...post,
        langs: ["en"],
        createdAt: now().toISOString(),
      },
    },
    token,
  });
  return {
    status: "posted",
    url: postUrl(session.handle ?? handle, created.uri ?? ""),
    text: post.text,
  };
}

function escapeCommand(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function summary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
}

function readText(name) {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

async function main(argv) {
  const [command, arg] = argv;
  if (command === "notes") {
    const section = changelogSection(readText("CHANGELOG.md"), arg ?? "");
    if (!section) {
      console.error(`CHANGELOG.md has no section for ${arg}.`);
      return 1;
    }
    process.stdout.write(`${section}\n`);
    return 0;
  }
  if (command !== "post") {
    console.error("Usage: announce.mjs notes <version> | announce.mjs post");
    return 2;
  }

  const env = process.env;
  const version = env.VERSION ?? "";
  try {
    const pkg = JSON.parse(readText("package.json"));
    const result = await announce({
      version,
      changelog: readText("CHANGELOG.md"),
      packageName: pkg.name,
      description: pkg.description,
      handle: env.BLUESKY_HANDLE,
      password: env.BLUESKY_APP_PASSWORD,
      pdsUrl: env.BLUESKY_PDS_URL,
    });
    if (result.status === "skipped") {
      console.log(`::notice title=Bluesky::v${version} was already announced.`);
      summary([`Bluesky: v${version} was already announced, nothing posted.`]);
    } else {
      console.log(`Posted ${result.url}`);
      summary([
        `Bluesky: [v${version} announced](${result.url}).`,
        "",
        "```text",
        result.text,
        "```",
      ]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning title=Bluesky announcement failed::${escapeCommand(message)}`,
    );
    summary([`Bluesky: the announcement of v${version} failed: ${message}`]);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
