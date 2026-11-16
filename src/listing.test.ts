import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotListing } from "./api.ts";
import {
  listingFromFlags,
  listingLines,
  listingPatch,
  mergeListing,
  patchLines,
  readListingFile,
  unknownListingField,
} from "./listing.ts";

const LISTING: BotListing = {
  listed: true,
  category: "weather",
  description: "Hourly weather for Paris.",
  languages: ["fr", "en"],
  showRecentPosts: true,
  operator: { name: "Météo Lab", shown: true },
  usage: [
    {
      kind: "mention",
      description: "Ask a forecast",
      example: "forecast Paris",
    },
  ],
  sourceUrl: "https://github.com/acme/weather-bot",
  openSource: true,
  supportUrl: null,
  disclosure: {
    purpose: "Posts the weather every hour",
    contact: "@acme.bsky.social",
    usesGenerativeAi: false,
    automationLevel: "automated",
    activities: ["scheduled_posts"],
  },
};

describe("unknownListingField", () => {
  it("accepts every field of BotListing", () => {
    expect(unknownListingField({ ...LISTING })).toBeNull();
    expect(unknownListingField({})).toBeNull();
  });

  it("names the first unknown field the way the server does", () => {
    expect(unknownListingField({ descripton: "x" })).toBe("descripton");
    expect(unknownListingField({ operator: { visible: true } })).toBe(
      "operator.visible",
    );
    expect(
      unknownListingField({
        usage: [
          { kind: "dm", description: "Hi" },
          { kind: "dm", note: "" },
        ],
      }),
    ).toBe("usage[1].note");
    expect(unknownListingField({ disclosure: { ai: true } })).toBe(
      "disclosure.ai",
    );
    // Never a key of Object.prototype.
    expect(unknownListingField(JSON.parse('{"toString": 1}'))).toBe("toString");
    expect(unknownListingField(JSON.parse('{"__proto__": {}}'))).toBe(
      "__proto__",
    );
  });

  it("leaves wrong types to the server", () => {
    expect(unknownListingField({ operator: "x", usage: "y" })).toBeNull();
  });
});

describe("readListingFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bsbot-listing-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function file(text: string) {
    const name = path.join(dir, "listing.json");
    await writeFile(name, text);
    return name;
  }

  it("reads a subset of the listing", async () => {
    expect(await readListingFile(await file('{"listed": false}'))).toEqual({
      listed: false,
    });
  });

  it("refuses an unknown field, bad JSON, a non-object or a missing file", async () => {
    await expect(
      readListingFile(await file('{"operator": {"visible": true}}')),
    ).rejects.toThrow("Unknown field `operator.visible`.");
    await expect(readListingFile(await file("{"))).rejects.toThrow(
      "not valid JSON",
    );
    await expect(readListingFile(await file("[]"))).rejects.toThrow(
      "JSON object",
    );
    await expect(readListingFile(path.join(dir, "nope.json"))).rejects.toThrow(
      "ENOENT",
    );
  });
});

describe("listingFromFlags", () => {
  it("maps the flags to listing fields", () => {
    expect(
      listingFromFlags({
        unlisted: true,
        category: "news",
        description: "Headlines.",
        languages: "en, fr,",
        "no-recent-posts": true,
        "operator-name": "Acme",
        "operator-hidden": true,
        "source-url": "https://github.com/acme/news",
        "open-source": true,
        "support-url": "https://ko-fi.com/acme",
      }),
    ).toEqual({
      listed: false,
      category: "news",
      description: "Headlines.",
      languages: ["en", "fr"],
      showRecentPosts: false,
      operator: { name: "Acme", shown: false },
      sourceUrl: "https://github.com/acme/news",
      openSource: true,
      supportUrl: "https://ko-fi.com/acme",
    });
    expect(listingFromFlags({})).toEqual({});
    expect(listingFromFlags({ "operator-shown": true })).toEqual({
      operator: { shown: true },
    });
  });

  it("clears a field with an empty value", () => {
    expect(
      listingFromFlags({ description: "", category: " ", languages: "" }),
    ).toEqual({ description: null, category: null, languages: [] });
  });

  it("refuses two opposite flags", () => {
    expect(() => listingFromFlags({ listed: true, unlisted: true })).toThrow(
      "--listed or --unlisted",
    );
    expect(() =>
      listingFromFlags({ "operator-shown": true, "operator-hidden": true }),
    ).toThrow(/not both/);
  });
});

describe("mergeListing", () => {
  it("puts the flags over the file, inside operator too", () => {
    expect(
      mergeListing(
        { listed: true, operator: { name: "A", shown: true } },
        { listed: false, operator: { shown: false } },
      ),
    ).toEqual({ listed: false, operator: { name: "A", shown: false } });
  });
});

describe("listingPatch", () => {
  it("keeps only what differs, key by key in nested objects", () => {
    expect(
      listingPatch(LISTING, {
        listed: true,
        description: "New.",
        operator: { name: "Météo Lab", shown: false },
        disclosure: { purpose: LISTING.disclosure.purpose, contact: null },
      }),
    ).toEqual({
      description: "New.",
      operator: { shown: false },
      disclosure: { contact: null },
    });
  });

  it("finds no change in the listing sent back", () => {
    expect(listingPatch(LISTING, structuredClone(LISTING))).toEqual({});
  });

  it('ignores key order, and reads "" as null and null lists as []', () => {
    const current = { ...LISTING, supportUrl: null, languages: [] };
    expect(
      listingPatch(current, {
        supportUrl: "",
        languages: null,
        usage: [
          {
            example: "forecast Paris",
            description: "Ask a forecast",
            kind: "mention",
          },
        ],
      }),
    ).toEqual({});
  });

  it("replaces a list as a whole", () => {
    expect(listingPatch(LISTING, { languages: ["fr"] })).toEqual({
      languages: ["fr"],
    });
  });

  it("prints a line per changed value", () => {
    expect(
      patchLines(LISTING, {
        listed: false,
        operator: { shown: false },
      }),
    ).toEqual(["listed: true → false", "operator.shown: true → false"]);
  });
});

describe("listingLines", () => {
  it("prints every field", () => {
    const text = listingLines(LISTING).join("\n");
    expect(text).toContain("Hourly weather for Paris.");
    expect(text).toContain("fr, en");
    expect(text).toContain("Météo Lab (shown)");
    expect(text).toContain("(open source)");
    expect(text).toContain(
      '1. mention: Ask a forecast (e.g. "forecast Paris")',
    );
    expect(text).toContain("scheduled_posts");
  });
});
