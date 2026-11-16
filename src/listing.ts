// `bsbot listing`: a bot's directory listing (bluesky.bot issue 284). The
// server holds the rules; the CLI only refuses unknown fields early, builds
// the patch of the fields that differ, and prints the listing.
import { readFile } from "node:fs/promises";
import type { BotListing, BotListingPatch } from "./api.ts";
import { UsageError } from "./errors.ts";

// The fields of `BotListing`, in the API's order; the keys of the nested
// objects. A usage line holds `kind`, `description` and `example`.
const NESTED: Record<string, readonly string[] | null> = {
  listed: null,
  category: null,
  description: null,
  languages: null,
  showRecentPosts: null,
  operator: ["name", "shown"],
  usage: null,
  sourceUrl: null,
  openSource: null,
  supportUrl: null,
  disclosure: [
    "purpose",
    "contact",
    "usesGenerativeAi",
    "automationLevel",
    "activities",
  ],
};
const USAGE_LINE_KEYS = ["kind", "description", "example"];
const LISTS = new Set(["languages", "usage", "disclosure.activities"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unknownKey = (value: Record<string, unknown>, known: readonly string[]) =>
  Object.keys(value).find((key) => !known.includes(key));

/**
 * The path of the first field `BotListing` does not have (`descripton`,
 * `operator.visible`, `usage[1].note`), as the server names it, or null.
 */
export function unknownListingField(
  doc: Record<string, unknown>,
): string | null {
  for (const [field, keys] of Object.entries(NESTED)) {
    const value = doc[field];
    if (keys && isObject(value)) {
      const extra = unknownKey(value, keys);
      if (extra !== undefined) return `${field}.${extra}`;
    }
    if (field === "usage" && Array.isArray(value)) {
      for (const [index, line] of value.entries()) {
        if (!isObject(line)) continue;
        const extra = unknownKey(line, USAGE_LINE_KEYS);
        if (extra !== undefined) return `usage[${index}].${extra}`;
      }
    }
  }
  return Object.keys(doc).find((key) => !Object.hasOwn(NESTED, key)) ?? null;
}

/** A JSON document of the `BotListing` shape (any subset of its fields). */
export async function readListingFile(
  file: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unreadable";
    throw new UsageError(`Cannot read ${file} (${code}).`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UsageError(`${file} is not valid JSON.`);
  }
  if (!isObject(doc)) {
    throw new UsageError(`${file} must hold a JSON object, like the listing.`);
  }
  const unknown = unknownListingField(doc);
  if (unknown !== null) throw new UsageError(`Unknown field \`${unknown}\`.`);
  return doc;
}

export type ListingFlags = {
  listed?: boolean;
  unlisted?: boolean;
  category?: string;
  description?: string;
  "no-description"?: boolean;
  languages?: string;
  "recent-posts"?: boolean;
  "no-recent-posts"?: boolean;
  "operator-name"?: string;
  operator?: string;
  "no-operator"?: boolean;
  "show-operator"?: boolean;
  "hide-operator"?: boolean;
  "operator-shown"?: boolean;
  "operator-hidden"?: boolean;
  "source-url"?: string;
  "open-source"?: boolean;
  "no-open-source"?: boolean;
  "support-url"?: string;
};

function either(
  flags: ListingFlags,
  yes: keyof ListingFlags,
  no: keyof ListingFlags,
): boolean | undefined {
  if (flags[yes] && flags[no]) {
    throw new UsageError(`Use --${yes} or --${no}, not both.`);
  }
  return flags[yes] ? true : flags[no] ? false : undefined;
}

/** An empty text clears the field. */
const text = (value: string | undefined) =>
  value === undefined ? undefined : value.trim() === "" ? null : value;

/** The listing fields the flags of `listing set` give. */
export function listingFromFlags(flags: ListingFlags): BotListingPatch {
  if (flags["no-description"] && flags.description !== undefined) {
    throw new UsageError("Use --description or --no-description, not both.");
  }
  if (flags.operator !== undefined && flags["operator-name"] !== undefined) {
    throw new UsageError("Use --operator or --operator-name, not both.");
  }
  const operatorName = flags.operator ?? flags["operator-name"];
  if (flags["no-operator"] && operatorName !== undefined) {
    throw new UsageError("Use --operator or --no-operator, not both.");
  }
  const languages =
    flags.languages === undefined
      ? undefined
      : flags.languages
          .split(",")
          .map((code) => code.trim())
          .filter(Boolean);
  const operator = {
    name: flags["no-operator"] ? null : text(operatorName),
    shown: either(
      {
        ...flags,
        "operator-shown": flags["operator-shown"] || flags["show-operator"],
        "operator-hidden": flags["operator-hidden"] || flags["hide-operator"],
      },
      "operator-shown",
      "operator-hidden",
    ),
  };
  const fields: BotListingPatch = {
    listed: either(flags, "listed", "unlisted"),
    category: flags.category === "none" ? null : text(flags.category),
    description: flags["no-description"] ? null : text(flags.description),
    languages,
    showRecentPosts: either(flags, "recent-posts", "no-recent-posts"),
    operator: dropUndefined(operator),
    sourceUrl: text(flags["source-url"]),
    openSource: either(flags, "open-source", "no-open-source"),
    supportUrl: text(flags["support-url"]),
  };
  return dropUndefined(fields);
}

function dropUndefined(value: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (isObject(item) && Object.keys(item).length === 0) continue;
    out[key] = item;
  }
  return out;
}

/** The file's fields, with the flags on top (inside `operator` too). */
export function mergeListing(
  file: BotListingPatch,
  flags: BotListingPatch,
): BotListingPatch {
  const merged = { ...file, ...flags };
  if (isObject(file.operator) && isObject(flags.operator)) {
    merged.operator = { ...file.operator, ...flags.operator };
  }
  return merged;
}

/** JSON with sorted keys, so two equal documents compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isObject(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

// The server stores "" as null and null lists as [].
const normal = (path: string, value: unknown) =>
  value === "" ? null : value === null && LISTS.has(path) ? [] : value;

const same = (path: string, a: unknown, b: unknown) =>
  canonical(normal(path, a)) === canonical(normal(path, b));

/**
 * The patch of the fields of `wanted` that differ from `current`: inside
 * `operator` and `disclosure`, only the keys that differ; a list as a whole.
 */
export function listingPatch(
  current: BotListing,
  wanted: BotListingPatch,
): BotListingPatch {
  const now = current as unknown as Record<string, unknown>;
  const patch: BotListingPatch = {};
  for (const [field, value] of Object.entries(wanted)) {
    const stored = now[field];
    if (NESTED[field] && isObject(value) && isObject(stored)) {
      const keys: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (!same(`${field}.${key}`, item, stored[key])) keys[key] = item;
      }
      if (Object.keys(keys).length > 0) patch[field] = keys;
    } else if (!same(field, value, stored)) {
      patch[field] = value;
    }
  }
  return patch;
}

const show = (value: unknown) =>
  value === undefined ? "(none)" : JSON.stringify(value);

/** One line per changed value: `operator.shown: false → true`. */
export function patchLines(
  current: BotListing,
  patch: BotListingPatch,
): string[] {
  const now = current as unknown as Record<string, unknown>;
  const lines: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const stored = now[field];
    if (NESTED[field] && isObject(value) && isObject(stored)) {
      for (const [key, item] of Object.entries(value)) {
        lines.push(`${field}.${key}: ${show(stored[key])} → ${show(item)}`);
      }
    } else {
      lines.push(`${field}: ${show(stored)} → ${show(value)}`);
    }
  }
  return lines;
}

const or = (value: string | null | undefined, none = "-") =>
  value === null || value === undefined || value === "" ? none : value;

const yesNo = (value: boolean | null | undefined) =>
  value === true ? "yes" : value === false ? "no" : "-";

/** The listing, one field a line. */
export function listingLines(listing: BotListing): string[] {
  const row = (label: string, value: string) => `${label.padEnd(20)} ${value}`;
  const lines = [
    row("listed", yesNo(listing.listed)),
    row("category", or(listing.category)),
    row("description", or(listing.description)),
    row("languages", or(listing.languages?.join(", "))),
    row("recent posts", listing.showRecentPosts ? "shown" : "hidden"),
    row(
      "operator",
      listing.operator?.name
        ? `${listing.operator.name} (${listing.operator.shown ? "shown" : "hidden"})`
        : "-",
    ),
    row(
      "source",
      listing.sourceUrl
        ? `${listing.sourceUrl}${listing.openSource ? " (open source)" : ""}`
        : "-",
    ),
    row("support", or(listing.supportUrl)),
  ];
  const usage = listing.usage ?? [];
  lines.push(usage.length ? "usage" : row("usage", "-"));
  usage.forEach((line, index) => {
    const example = line.example ? ` (e.g. "${line.example}")` : "";
    lines.push(`  ${index + 1}. ${line.kind}: ${line.description}${example}`);
  });
  const d = listing.disclosure;
  if (d) {
    const sub = (label: string, value: string) =>
      `  ${label.padEnd(18)} ${value}`;
    lines.push(
      "disclosure",
      sub("purpose", or(d.purpose)),
      sub("contact", or(d.contact)),
      sub("generative AI", yesNo(d.usesGenerativeAi)),
      sub("automation", or(d.automationLevel)),
      sub("activities", or(d.activities?.join(", "))),
    );
  }
  return lines;
}
