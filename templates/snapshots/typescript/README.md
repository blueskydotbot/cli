# Your small Bluesky bot (typescript)

Review these files, then clone the development branch for your own bot.
This is source code for running your own bot; it does not provision hosting on Bluesky.bot.
Use Node.js 24 and pnpm 12.18.0.

## Development source

```sh
git clone --branch develop https://github.com/blueskydotbot/bot-template-typescript.git my-bluesky-bot
cd my-bluesky-bot
```

This branch is a development snapshot, without a stable template tag. A future release can populate the default branch for GitHub's **Use this template** flow. The current workflows are manual-only; cloning this code does not enable a posting schedule or provision secrets.

## Start safely

1. Read the code and edit `posts.txt`. Each live run signs in once, sets the Automation self-label without replacing other profile fields, and publishes at most one line not present in the latest 25 feed entries. If every line is recent, nothing is posted. Add enough original content for your schedule.
2. Run the default dry run: it makes no login, write or network request and needs no credentials.

```sh
pnpm install --frozen-lockfile
pnpm start
```

3. Create an app password while signed in as the **bot**, not your personal account (Bluesky Settings → Privacy and security → App passwords). Never use the main password or commit credentials. `.env` files are ignored; the runner reads environment variables rather than loading `.env` automatically.
4. In your own GitHub repository, add secrets `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`. Set repository variable `DRY_RUN=false` only when ready to publish. Automatic workflows are paused in this development snapshot: the workflow files are manual-only. A future enabled schedule can run twice an hour with one non-overlapping concurrency group and a five-minute timeout. **Do not enable posting before reviewing what the bot will post.** GitHub may delay scheduled runs and disables schedules in public repositories after 60 days without repository activity: monitor your bot, or run it on your own computer/cron.
5. Claim `name.bluesky.bot` at https://bluesky.bot and choose whether to list the bot. Suggested bio: “🤖 Automated account · run by @you”. Docs: https://bluesky.bot/docs/templates .

## Behaviour and controls

- `DRY_RUN=true` is the default. It does not sign in, edit a profile, post, reply or mark notifications seen.
- `SET_SELF_LABEL=false` opts out of the first-run self-label. The label helper retries a compare-and-swap conflict once and refuses unknown label shapes; it never drops other profile data.
- `MAX_POSTS_PER_RUN=1` defaults to one (hard cap 5). TypeScript checks 300 graphemes/3000 UTF-8 bytes; Python uses a conservative 300-code-point cap, also guaranteeing the grapheme bound. Links/hashtags are made clickable.
- `REPLY_TO_MENTIONS=false` is the default. Replies are only to unread direct mentions or replies, skip self-labelled bot authors, your own account, blocks and mutes, and use the original thread root and parent. Cap: `MAX_REPLIES_PER_RUN=5` (hard cap 5). The watermark is captured before reading. Replies are best effort; review failures before running again because a failed partial run can leave already-answered notifications unread.
- A 429 or any other failed call stops the run; no retry loop or catch-up burst. A 429 logs only the reset time; check it before re-running. Never log a raw exception or token.
- Respect Bluesky's automation and spam rules: https://bluesky.bot/docs/best-practices .

## Optional listing sync

`bluesky-bot.json` starts with `listed: false`. Edit it yourself, then use a listing-only deploy token from Bluesky.bot Settings, ideally restricted to this bot. Put it in your repository secret `BSBOT_TOKEN`, and the bot DID in repository variable `BOT_DID`. `listing.yml` makes one PATCH when manually run. Its automatic push trigger is paused during development. Without both settings it skips. It uses the HTTP API directly, so it does not require an unpublished CLI command. Keep the token secret and rotate it when it expires.

## Tests and maintenance

Run `pnpm typecheck` and `pnpm test`. Tests use mocks and dry runs, no live account. The CI sample never receives posting secrets. Dependencies and GitHub actions are pinned; automatic Dependabot update PRs are paused. Review updates before merging, and enable the maintenance workflows only when ready. License: MIT-0, no attribution required.
