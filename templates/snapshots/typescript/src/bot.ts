import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AtpAgent, RichText } from "@atproto/api";
import { replyToMentions } from "./reply-to-mentions";
import { ensureSelfLabel } from "./self-label";

export async function runBot(
  env: NodeJS.ProcessEnv = process.env,
  agent = new AtpAgent({
    service: env.BLUESKY_SERVICE || "https://bsky.social",
  }),
  lines = readFileSync(new URL("../posts.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim()),
) {
  // Dry run is the default: no login, no profile edit, no post or seen update.
  if (env.DRY_RUN !== "false") {
    console.log("Dry run: one scheduled text; replies disabled.");
    console.log(lines[0] ?? "Nothing to post.");
    return;
  }
  if (!env.BLUESKY_HANDLE || !env.BLUESKY_APP_PASSWORD)
    throw new Error(
      "Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD repository secrets.",
    );
  await agent.login({
    identifier: env.BLUESKY_HANDLE,
    password: env.BLUESKY_APP_PASSWORD,
  });
  if (env.SET_SELF_LABEL !== "false") await ensureSelfLabel(agent);
  const feed = await agent.getAuthorFeed({ actor: agent.assertDid, limit: 25 });
  const recent = new Set(
    feed.data.feed.map((item) => (item.post.record as { text?: string })?.text),
  );
  const options = lines.filter((line) => !recent.has(line));
  const maximum = Math.min(
    5,
    Math.max(0, Number.parseInt(env.MAX_POSTS_PER_RUN ?? "1", 10) || 0),
  );
  for (let index = 0; index < maximum && options.length; index++) {
    const text = new RichText({
      text: options.splice(Math.floor(Math.random() * options.length), 1)[0],
    });
    if (
      text.graphemeLength > 300 ||
      Buffer.byteLength(text.text, "utf8") > 3000
    )
      continue;
    await text.detectFacets(agent);
    await agent.post({
      text: text.text,
      facets: text.facets,
      createdAt: new Date().toISOString(),
    });
  }
  if (env.REPLY_TO_MENTIONS === "true")
    await replyToMentions(agent, {
      dryRun: false,
      max: Number.parseInt(env.MAX_REPLIES_PER_RUN ?? "5", 10) || 0,
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runBot();
  } catch (error) {
    const limited =
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 429;
    // Stop after the first failure. Never log credentials or raw responses.
    const headers =
      error && typeof error === "object" && "headers" in error
        ? (error.headers as Record<string, string>)
        : {};
    const reset = /^\d+$/.test(headers?.["ratelimit-reset"] ?? "")
      ? headers["ratelimit-reset"]
      : "the server's reset time";
    console.error(
      limited
        ? `Rate limited. Wait until ${reset} before the next run.`
        : "The bot stopped. Check the account and service before running again.",
    );
    process.exitCode = 1;
  }
}
