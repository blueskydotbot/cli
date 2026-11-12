[![cli.bluesky.bot on Bluesky.bot](https://bluesky.bot/badge/cli.bluesky.bot.svg)](https://bluesky.bot/bots/cli)

# bsbot

Manage your Bluesky bots and their `name.bluesky.bot` handles from the
terminal: sign in with Bluesky, then claim, switch, verify and release handles.
No dependencies, Node.js 22+.

Signing in happens in your browser, so no password ever goes through the
terminal. You can also list your bots and browse the directory of
[Bluesky.bot](https://bluesky.bot).

```bash
npm install --global @blueskydotbot/cli
bsbot login
bsbot check weather
bsbot claim weather.bsky.social weather
bsbot verify weather
```

## Install

The npm package is
[`@blueskydotbot/cli`](https://www.npmjs.com/package/@blueskydotbot/cli); the
command it installs is `bsbot`. Install it once:

```bash
npm install --global @blueskydotbot/cli
bsbot --help
```

Or run it without installing, with `npx @blueskydotbot/cli <command>` (for
example `npx @blueskydotbot/cli login`). Other package managers work too:
`pnpm dlx @blueskydotbot/cli`, `yarn dlx @blueskydotbot/cli` or
`bunx @blueskydotbot/cli`.

Requirements: macOS or Linux, Node.js 22 or later. No dependency.

## Usage

| Command | What it does |
| --- | --- |
| `login` | Signs in through the browser (`--no-browser`, `--name <label>`) |
| `logout` | Revokes this machine's token and forgets it |
| `whoami` | The account you are signed in as |
| `bots` | Your bots, their handle, and whether it is live |
| `check <name>` | Whether `<name>.bluesky.bot` is free (no sign-in needed) |
| `claim <bot> <name>` | Claims `<name>.bluesky.bot` for a bot and switches the bot to it |
| `switch <bot>` | Asks the bot's server again to use its handle |
| `verify <bot>` | Checks that the handle is live on Bluesky |
| `release <bot>` | Gives the handle up (asks first, or add `--yes`) |
| `directory` | Browses the public directory (`--q`, `--category`, `--verified`, `--limit`, `--cursor`) |

`<bot>` is a bot's DID, its handle, its previous handle, or the name of its
`.bluesky.bot` handle. Every command takes `--json` for scripts; the exit code
is `0` on success, `1` on an error and `2` on a usage mistake. Run
`bsbot --help` for the details, and see https://bluesky.bot/docs/cli.

## Bugs and ideas

Found a bug or missing a command? Open an issue at
https://github.com/blueskydotbot/cli/issues with the version
(`bsbot --version`), the command and what it printed. Never paste your token.

## Security

- The token is saved in `~/.config/bsbot/credentials.json` (or
  `$XDG_CONFIG_HOME/bsbot/`, or `$BSBOT_CONFIG_DIR`), readable by you only.
  It lasts 30 days and is never printed, not even with `--json`.
- It can only manage your bots' handles: it cannot post, follow, read your
  Bluesky account or change your settings.
- `bsbot logout` revokes it; so does **Settings → CLI access** on
  bluesky.bot.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm test
npm run build
node dist/bin.js --help
```

Node.js 24 can also run the TypeScript sources directly:
`node src/bin.ts --help`.

`--api-url <url>` (or `BSBOT_API_URL`) points the CLI at another server; plain
`http` is only accepted for `localhost`, `127.0.0.1` and `[::1]`. When you
try a change against a local development server of bluesky.bot, keep its
credentials apart from your real ones:

```bash
export BSBOT_CONFIG_DIR="$(mktemp -d)"
node dist/bin.js check weather --api-url http://localhost:3000
node dist/bin.js login --api-url http://localhost:3000
```

Credentials are bound to the server that issued them: switching servers needs
a new `login`.

## Contributing

Bug reports and ideas are welcome in
[GitHub issues](https://github.com/blueskydotbot/cli/issues). For a pull
request, open an issue first for anything larger than a small fix, keep the
CLI free of runtime dependencies, add tests, and add a line to the
`[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md). `npm test` and
`npm run build` must pass.

Each stable version gets a GitHub Release with its changelog, and is announced
on Bluesky by [@cli.bluesky.bot](https://bsky.app/profile/cli.bluesky.bot):
follow it to hear about new versions. Maintainers release as described in
[RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
