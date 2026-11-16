// Replies are opt-in. Call after signing in once as the bot.
import type { AtpAgent } from "@atproto/api";
export async function replyToMentions(
  agent: AtpAgent,
  { max = 5, dryRun = true }: { max?: number; dryRun?: boolean } = {},
): Promise<number> {
  // Capture the watermark before reading so newer notifications stay unread.
  const seenAt = new Date().toISOString();
  const { data } = await agent.app.bsky.notification.listNotifications({
    limit: 100,
  });
  let sent = 0;
  for (const notification of data.notifications) {
    if (sent >= Math.min(5, Math.max(0, max))) break;
    if (
      notification.isRead ||
      !["mention", "reply"].includes(notification.reason) ||
      notification.author.did === agent.assertDid
    )
      continue;
    const { data: profile } = await agent.getProfile({
      actor: notification.author.did,
    });
    const selfUri = `at://${profile.did}/app.bsky.actor.profile/self`;
    if (
      profile.viewer?.blockedBy ||
      profile.viewer?.blocking ||
      profile.viewer?.muted ||
      profile.labels?.some(
        (label) =>
          label.val === "bot" &&
          label.src === profile.did &&
          label.uri === selfUri &&
          !label.neg,
      )
    )
      continue;
    const record = notification.record as {
      $type?: string;
      reply?: { root?: { uri: string; cid: string } };
    };
    if (record?.$type !== "app.bsky.feed.post") continue;
    const parent = { uri: notification.uri, cid: notification.cid };
    const existingRoot = record.reply?.root;
    const root =
      existingRoot &&
      typeof existingRoot.uri === "string" &&
      typeof existingRoot.cid === "string"
        ? existingRoot
        : parent;
    // Never retry a failed write here: the caller stops on 429 or any error.
    if (!dryRun)
      await agent.post({
        text: "Thanks for asking! 🤖",
        reply: { root, parent },
        createdAt: new Date().toISOString(),
      });
    sent++;
  }
  if (!dryRun) await agent.app.bsky.notification.updateSeen({ seenAt });
  return sent;
}
