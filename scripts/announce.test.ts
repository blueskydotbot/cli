import { describe, expect, it, vi } from "vitest";
import {
  alreadyAnnounced,
  announce,
  buildPost,
  bullets,
  byteLength,
  changelogSection,
  graphemeLength,
  MAX_GRAPHEMES,
  normalizePdsUrl,
  truncate,
} from "./announce.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

- Something not released yet.

## [0.2.0] - 2026-12-01

### Added

- \`bsbot rename\` moves a bot to a new \`name.bluesky.bot\` handle, keeping
  its directory listing.
- **Breaking:** \`--json\` errors now carry a \`hint\` field, see the
  [docs](https://bluesky.bot/docs/cli).
  - A nested detail that stays out of the post.

### Fixed

- Clearer message when the browser cannot be opened.
- A fourth change that does not fit in the post.

## [0.1.0] - 2026-11-12

- First release.

[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
`;

describe("changelogSection", () => {
  it("returns the body of one version", () => {
    const section = changelogSection(CHANGELOG, "0.2.0");
    expect(section).toMatch(/^### Added/);
    expect(section).toMatch(/A fourth change that does not fit in the post\.$/);
    expect(changelogSection(CHANGELOG, "0.1.0")).toBe("- First release.");
  });

  it("does not confuse versions and returns null when missing", () => {
    expect(changelogSection(CHANGELOG, "0.2")).toBeNull();
    expect(changelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });
});

describe("bullets", () => {
  it("joins wrapped lines, drops nested items and markdown", () => {
    expect(bullets(changelogSection(CHANGELOG, "0.2.0") ?? "")).toEqual([
      "bsbot rename moves a bot to a new name.bluesky.bot handle, keeping its directory listing.",
      "Breaking: --json errors now carry a hint field, see the docs.",
      "Clearer message when the browser cannot be opened.",
      "A fourth change that does not fit in the post.",
    ]);
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("Déjà vu 👍🏽", 10)).toBe("Déjà vu 👍🏽");
  });

  it("never splits a grapheme", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `${family}${family}${family}${family}`;
    const cut = truncate(text, 3);
    expect(cut).toBe(`${family}${family}…`);
    expect(graphemeLength(cut)).toBe(3);

    const accents = "é".repeat(10);
    const cutAccents = truncate(accents, 4);
    expect(cutAccents).toBe(`${"é".repeat(3)}…`);
  });

  it("prefers a word break and stays within the limit", () => {
    const cut = truncate(
      "Clearer message when the browser cannot be opened",
      30,
    );
    expect(cut).toBe("Clearer message when the…");
    expect(graphemeLength(cut)).toBeLessThanOrEqual(30);
  });
});

const packageName = "@blueskydotbot/cli";

describe("buildPost", () => {
  const description =
    "Manage your Bluesky bots and their name.bluesky.bot handles from the terminal.";

  it("builds the text, the link facet and the card", () => {
    const post = buildPost({
      packageName,
      version: "0.2.0",
      section: changelogSection(CHANGELOG, "0.2.0"),
      description,
    });
    expect(post.text).toBe(
      [
        "bsbot v0.2.0 is out",
        "",
        "• bsbot rename moves a bot to a new name.bluesky.bot handle, keeping its directory listing.",
        "• Breaking: --json errors now carry a hint field, see the docs.",
        "• Clearer message when the browser cannot be…",
        "",
        "npx @blueskydotbot/cli@latest",
        "npmjs.com/package/@blueskydotbot/cli/v/0.2.0",
      ].join("\n"),
    );
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_GRAPHEMES);

    const [facet] = post.facets;
    const bytes = new TextEncoder().encode(post.text);
    const linked = new TextDecoder().decode(
      bytes.slice(facet.index.byteStart, facet.index.byteEnd),
    );
    expect(linked).toBe("npmjs.com/package/@blueskydotbot/cli/v/0.2.0");
    expect(facet.features).toEqual([
      {
        $type: "app.bsky.richtext.facet#link",
        uri: "https://www.npmjs.com/package/@blueskydotbot/cli/v/0.2.0",
      },
    ]);
    expect(post.embed).toEqual({
      $type: "app.bsky.embed.external",
      external: {
        uri: "https://www.npmjs.com/package/@blueskydotbot/cli/v/0.2.0",
        title: "@blueskydotbot/cli 0.2.0 on npm",
        description,
      },
    });
  });

  it("counts bytes, not characters, for the facet with non-ASCII text", () => {
    const section = [
      "- Messages en français : « déjà réservé » 🎉🎉, ½ the wait.",
      "- 日本語のメッセージ 🤖",
    ].join("\n");
    const post = buildPost({
      packageName,
      version: "1.0.0",
      section,
      description,
    });
    const { byteStart, byteEnd } = post.facets[0].index;
    const prefix = post.text.slice(0, post.text.lastIndexOf("npmjs.com"));
    expect(byteStart).toBe(byteLength(prefix));
    expect(byteStart).toBeGreaterThan(prefix.length);
    expect(byteEnd - byteStart).toBe(
      byteLength("npmjs.com/package/@blueskydotbot/cli/v/1.0.0"),
    );
    const linked = new TextDecoder().decode(
      new TextEncoder().encode(post.text).slice(byteStart, byteEnd),
    );
    expect(linked).toBe("npmjs.com/package/@blueskydotbot/cli/v/1.0.0");
  });

  it("truncates long bullets cleanly and stays within 300 graphemes", () => {
    const long = `${"Réécrit l’affichage des bots 🤖 ".repeat(20)}fin.`;
    const section = [`- ${long}`, `- ${long}`, `- ${long}`, `- ${long}`].join(
      "\n",
    );
    const post = buildPost({
      packageName,
      version: "10.20.30",
      section,
      description,
    });
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_GRAPHEMES);
    const lines = post.text.split("\n").filter((line) => line.startsWith("• "));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(line).toMatch(/[^\s]…$/u);
    expect(
      post.text.endsWith(
        "\n\nnpx @blueskydotbot/cli@latest\nnpmjs.com/package/@blueskydotbot/cli/v/10.20.30",
      ),
    ).toBe(true);
  });

  it("still posts the version and link without a changelog section", () => {
    const post = buildPost({
      packageName,
      version: "0.3.0",
      section: null,
      description,
    });
    expect(post.text).toBe(
      "bsbot v0.3.0 is out\n\nnpx @blueskydotbot/cli@latest\nnpmjs.com/package/@blueskydotbot/cli/v/0.3.0",
    );
  });
});

describe("buildPost with a very long package name", () => {
  it("keeps the full URL in the facet and card, behind a shorter text", () => {
    const longName = `@${"a".repeat(100)}/${"b".repeat(100)}`;
    const post = buildPost({
      packageName: longName,
      version: "1.0.0",
      section: "- One change.",
      description: "d",
    });
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_GRAPHEMES);
    expect(post.text.endsWith("\nnpmjs.com")).toBe(true);
    const url = `https://www.npmjs.com/package/${longName}/v/1.0.0`;
    expect(post.facets[0].features[0].uri).toBe(url);
    expect(post.embed.external.uri).toBe(url);
    const { byteStart, byteEnd } = post.facets[0].index;
    expect(
      new TextDecoder().decode(
        new TextEncoder().encode(post.text).slice(byteStart, byteEnd),
      ),
    ).toBe("npmjs.com");
  });
});

describe("alreadyAnnounced", () => {
  const records = (...texts: string[]) =>
    texts.map((text) => ({ value: { text } }));

  it("finds the exact version only", () => {
    expect(
      alreadyAnnounced(records("hello", "bsbot v0.2.0 is out\n\n…"), "0.2.0"),
    ).toBe(true);
    expect(alreadyAnnounced(records("bsbot v0.2.0."), "0.2.0")).toBe(true);
    expect(alreadyAnnounced(records("bsbot v0.2.01 is out"), "0.2.0")).toBe(
      false,
    );
    expect(alreadyAnnounced(records("bsbot v0.2.0.1 is out"), "0.2.0")).toBe(
      false,
    );
    expect(alreadyAnnounced(records("bsbot v0.2.0-rc.1 is out"), "0.2.0")).toBe(
      false,
    );
    expect(alreadyAnnounced(records("bsbot v0x2x0"), "0.2.0")).toBe(false);
    expect(alreadyAnnounced([{}, { value: {} }], "0.2.0")).toBe(false);
  });
});

describe("normalizePdsUrl", () => {
  it("defaults to bsky.social and refuses plain http elsewhere than this machine", () => {
    expect(normalizePdsUrl(undefined)).toBe("https://bsky.social");
    expect(normalizePdsUrl("")).toBe("https://bsky.social");
    expect(normalizePdsUrl("http://127.0.0.1:2583/")).toBe(
      "http://127.0.0.1:2583",
    );
    expect(() => normalizePdsUrl("http://bsky.social")).toThrow(/https/);
    expect(() => normalizePdsUrl("https://u:p@bsky.social")).toThrow();
    expect(() => normalizePdsUrl("nope")).toThrow();
  });
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakePds(posts: string[] = []) {
  return vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    switch (url.pathname) {
      case "/xrpc/com.atproto.server.createSession":
        return json(200, {
          did: "did:plc:abc",
          handle: "cli.example.com",
          accessJwt: "access-token",
          refreshJwt: "refresh-token",
        });
      case "/xrpc/com.atproto.repo.listRecords":
        return json(200, {
          records: posts.map((text) => ({ value: { text } })),
        });
      case "/xrpc/com.atproto.repo.createRecord":
        return json(200, {
          uri: "at://did:plc:abc/app.bsky.feed.post/3kxyz",
          cid: "bafy",
          body: init?.body,
        });
      default:
        return json(404, { error: "MethodNotImplemented" });
    }
  });
}

describe("announce", () => {
  const base = {
    version: "0.2.0",
    changelog: CHANGELOG,
    packageName,
    description: "The CLI.",
    handle: "cli.example.com",
    password: "app-password",
    pdsUrl: "https://pds.example.com",
    now: () => new Date("2026-12-01T10:00:00.000Z"),
  };

  it("signs in, checks recent posts, then creates the post", async () => {
    const fetch = fakePds(["an older post"]);
    const result = await announce({ ...base, fetch });

    expect(result).toMatchObject({
      status: "posted",
      url: "https://bsky.app/profile/cli.example.com/post/3kxyz",
    });
    expect(fetch).toHaveBeenCalledTimes(3);

    const [sessionUrl, sessionInit] = fetch.mock.calls[0];
    expect(String(sessionUrl)).toBe(
      "https://pds.example.com/xrpc/com.atproto.server.createSession",
    );
    expect(sessionInit?.method).toBe("POST");
    expect(JSON.parse(String(sessionInit?.body))).toEqual({
      identifier: "cli.example.com",
      password: "app-password",
    });

    const [listUrl, listInit] = fetch.mock.calls[1];
    const list = new URL(String(listUrl));
    expect(list.pathname).toBe("/xrpc/com.atproto.repo.listRecords");
    expect(Object.fromEntries(list.searchParams)).toEqual({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      limit: "25",
    });
    expect(listInit?.method).toBe("GET");
    expect((listInit!.headers as Record<string, string>).authorization).toBe(
      "Bearer access-token",
    );

    const [createUrl, createInit] = fetch.mock.calls[2];
    expect(String(createUrl)).toBe(
      "https://pds.example.com/xrpc/com.atproto.repo.createRecord",
    );
    expect((createInit!.headers as Record<string, string>).authorization).toBe(
      "Bearer access-token",
    );
    const body = JSON.parse(String(createInit?.body));
    expect(body.repo).toBe("did:plc:abc");
    expect(body.collection).toBe("app.bsky.feed.post");
    expect(body.record).toMatchObject({
      $type: "app.bsky.feed.post",
      langs: ["en"],
      createdAt: "2026-12-01T10:00:00.000Z",
      embed: { $type: "app.bsky.embed.external" },
    });
    expect(body.record.text).toMatch(/^bsbot v0\.2\.0 is out\n/);
    expect(body.record.facets).toHaveLength(1);
    expect(result.text).toBe(body.record.text);
  });

  it("does not post twice", async () => {
    const fetch = fakePds([
      "bsbot v0.2.0 is out\n\nnpx @blueskydotbot/cli@latest",
    ]);
    await expect(announce({ ...base, fetch })).resolves.toEqual({
      status: "skipped",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports the server error without the password", async () => {
    const fetch = vi.fn(async () =>
      json(401, {
        error: "AuthenticationRequired",
        message: "Invalid identifier or password",
      }),
    );
    const error = await announce({ ...base, fetch }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "com.atproto.server.createSession failed with HTTP 401 (AuthenticationRequired: Invalid identifier or password).",
    );
    expect(error.message).not.toContain("app-password");
  });

  it("refuses prereleases and missing credentials before any request", async () => {
    const fetch = fakePds();
    await expect(
      announce({ ...base, version: "0.3.0-rc.1", fetch }),
    ).rejects.toThrow(/stable/);
    await expect(announce({ ...base, password: "", fetch })).rejects.toThrow(
      /BLUESKY_APP_PASSWORD/,
    );
    await expect(
      announce({ ...base, handle: undefined, fetch }),
    ).rejects.toThrow(/BLUESKY_HANDLE/);
    await expect(announce({ ...base, packageName: "", fetch })).rejects.toThrow(
      /package name/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
