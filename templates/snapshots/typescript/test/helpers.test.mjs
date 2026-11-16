import assert from "node:assert/strict";
import test from "node:test";
import { replyToMentions } from "../src/reply-to-mentions.ts";
import { ensureSelfLabel } from "../src/self-label.ts";

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
function fake(record = {}, notices = []) {
  const calls = { writes: [], posts: [], seen: [], profiles: [], reads: 0 };
  const agent = {
    assertDid: DID,
    com: {
      atproto: {
        repo: {
          getRecord: async () => {
            calls.reads++;
            return {
              data: { cid: "cid-before", value: structuredClone(record) },
            };
          },
          putRecord: async (input) => {
            calls.writes.push(input);
          },
        },
      },
    },
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({ data: { notifications: notices } }),
          updateSeen: async (value) => {
            calls.seen.push(value);
          },
        },
      },
    },
    getProfile: async ({ actor }) => {
      calls.profiles.push(actor);
      return {
        data: {
          did: actor,
          labels: actor.endsWith("automated")
            ? [
                {
                  val: "bot",
                  src: actor,
                  uri: `at://${actor}/app.bsky.actor.profile/self`,
                },
              ]
            : [],
        },
      };
    },
    post: async (value) => {
      calls.posts.push(value);
      return { uri: "at://example", cid: "cid" };
    },
  };
  return { agent, calls };
}
test("self-label preserves complete profile and other labels, then is a no-op", async () => {
  const record = {
    displayName: "Keep",
    description: "Keep",
    avatar: { $type: "blob", ref: { $link: "cid" } },
    extension: { extra: 1 },
    labels: {
      $type: "com.atproto.label.defs#selfLabels",
      values: [{ val: "graphic-media", extra: 1 }],
    },
  };
  const { agent, calls } = fake(record);
  assert.equal(await ensureSelfLabel(agent), true);
  assert.equal(calls.writes[0].swapRecord, "cid-before");
  assert.deepEqual(
    { ...calls.writes[0].record, labels: record.labels, $type: undefined },
    { ...record, $type: undefined },
  );
  assert.deepEqual(calls.writes[0].record.labels.values, [
    { val: "graphic-media", extra: 1 },
    { val: "bot" },
  ]);
  const already = fake(calls.writes[0].record);
  assert.equal(await ensureSelfLabel(already.agent), false);
  assert.equal(already.calls.writes.length, 0);
});
test("a profile CAS conflict re-reads once and never silently overwrites", async () => {
  const { agent, calls } = fake({ displayName: "Old" });
  let attempts = 0;
  agent.com.atproto.repo.putRecord = async (value) => {
    calls.writes.push(value);
    if (attempts++ === 0) throw { error: "InvalidSwap" };
  };
  agent.com.atproto.repo.getRecord = async () => ({
    data: {
      cid: `cid-${attempts}`,
      value: { displayName: attempts ? "New" : "Old" },
    },
  });
  await ensureSelfLabel(agent);
  assert.equal(calls.writes[1].record.displayName, "New");
  assert.equal(calls.writes[1].swapRecord, "cid-1");
  const missing = fake();
  missing.agent.com.atproto.repo.getRecord = async () => {
    throw { error: "RecordNotFound" };
  };
  await ensureSelfLabel(missing.agent);
  assert.equal(missing.calls.writes[0].swapRecord, null);
});
test("unknown profile label types and excess labels are refused; dry run writes nothing", async () => {
  await assert.rejects(() =>
    ensureSelfLabel(fake({ labels: { $type: "unknown", values: [] } }).agent),
  );
  await assert.rejects(() =>
    ensureSelfLabel(
      fake({
        labels: {
          $type: "com.atproto.label.defs#selfLabels",
          values: Array.from({ length: 10 }, (_, index) => ({
            val: `label${index}`,
          })),
        },
      }).agent,
    ),
  );
  const dry = fake();
  await ensureSelfLabel(dry.agent, true);
  assert.equal(dry.calls.writes.length, 0);
});
const notice = (author, patch = {}) => ({
  author: { did: author },
  reason: "mention",
  isRead: false,
  uri: `at://${author}/app.bsky.feed.post/3k3akefak3k2k`,
  cid: "bafyreicjxzvqnhmst6x5lnvsdqjwi2xi7aowpk7j2n3mghjphbms5n2tvy",
  record: { $type: "app.bsky.feed.post" },
  ...patch,
});
test("replies filter unread direct requests, skip self/automated authors, preserve thread refs and cap", async () => {
  const root = {
    uri: "at://did:plc:root/app.bsky.feed.post/root",
    cid: "cid-root",
  };
  const notices = [
    notice("did:plc:read", { isRead: true }),
    notice("did:plc:like", { reason: "like" }),
    notice(DID),
    notice("did:plc:automated"),
    notice("did:plc:human", {
      record: { $type: "app.bsky.feed.post", reply: { root } },
    }),
    notice("did:plc:second"),
  ];
  const { agent, calls } = fake({}, notices);
  const before = Date.now();
  assert.equal(await replyToMentions(agent, { dryRun: false, max: 1 }), 1);
  assert.deepEqual(calls.posts[0].reply, {
    root,
    parent: { uri: notices[4].uri, cid: notices[4].cid },
  });
  assert.equal(calls.seen.length, 1);
  assert.ok(Date.parse(calls.seen[0].seenAt) >= before);
  assert.ok(Date.parse(calls.seen[0].seenAt) <= Date.now());
  const dry = fake({}, [notice("did:plc:human")]);
  assert.equal(await replyToMentions(dry.agent), 1);
  assert.equal(dry.calls.posts.length, 0);
  assert.equal(dry.calls.seen.length, 0);
});
test("429 stops immediately without a retry or seen update", async () => {
  const { agent, calls } = fake({}, [
    notice("did:plc:one"),
    notice("did:plc:two"),
  ]);
  agent.post = async () => {
    throw { status: 429, headers: { "ratelimit-reset": "100" } };
  };
  await assert.rejects(() => replyToMentions(agent, { dryRun: false }));
  assert.equal(calls.profiles.length, 1);
  assert.equal(calls.seen.length, 0);
});
