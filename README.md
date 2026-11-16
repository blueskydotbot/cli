[![cli.bluesky.bot on Bluesky.bot](https://bluesky.bot/badge/cli.bluesky.bot.svg)](https://bluesky.bot/bots/cli)

# bsbot

Manage your Bluesky bots and their `name.bluesky.bot` handles from the
terminal: sign in with Bluesky, then claim, switch, verify and release handles.
No dependencies, Node.js 22+.

Signing in happens in your browser, so no password ever goes through the
terminal. You can also run your bots' checkup, edit their directory listing
(from a CI job too), browse the directory of [Bluesky.bot](https://bluesky.bot)
and run its free tools.

```bash
npm install --global @blueskydotbot/cli
bsbot login
bsbot check weather
bsbot claim weather.bsky.social weather
bsbot verify weather
bsbot doctor weather
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

## Development status

This README describes the source under development. The listing, checkup and
tool additions below are unreleased; use your installed `bsbot --help` to check
its available commands. The server support must be deployed before a CLI
version using it is published; see [RELEASING.md](RELEASING.md).

## Usage

| Command | What it does |
| --- | --- |
| `login` | Signs in through the browser (`--no-browser`, `--name <label>`) |
| `logout` | Revokes this machine's token and forgets it |
| `whoami` | The account you are signed in as, and what the token may do |
| `bots` | Your bots, their handle, and whether it is live |
| `doctor [<bot>]` | The bot's checkup: what to fix in its disclosure and setup (every bot without `<bot>`; `--strict`, `--verbose`) |
| `listing get <bot>` | The bot's directory listing |
| `listing set <bot>` | Changes the listing from flags or `--file` (see below) |
| `check <name>` | Whether `<name>.bluesky.bot` is free (no sign-in needed) |
| `claim <bot> <name>` | Claims `<name>.bluesky.bot` for a bot and switches the bot to it |
| `switch <bot>` | Asks the bot's server again to use its handle |
| `verify <bot>` | Checks that the handle is live on Bluesky |
| `release <bot>` | Gives the handle up (asks first, or add `--yes`) |
| `directory` | Browses the public directory (`--q`, `--category`, `--verified`, `--limit`, `--cursor`) |
| `tool [<slug> key=value ...]` | Lists the [free tools](https://bluesky.bot/tools), or runs one |

`<bot>` is a bot's DID, its handle, its previous handle, or the name of its
`.bluesky.bot` handle. Every command takes `--json` for scripts; the exit code
is `0` on success, `1` on an error and `2` on a usage mistake, plus `3` when
`doctor` finds a check to fix (or a suggestion, with `--strict`). Errors print
the server's message; with `--json` they are
`{ "error": { "code", "message" } }` on stderr, plus `field` and `reason` for a
refused listing field, `parameter` for a refused parameter and `scope` for a
token that lacks one. Run `bsbot --help` for the details, and see
https://bluesky.bot/docs/cli.

### The checkup

```bash
bsbot doctor weather          # one bot, every check with a link to fix it
bsbot doctor --verbose        # every bot, one line each, then the checks
bsbot doctor weather --strict # exit code 3 on a suggestion too
```

`--json` prints the server's document as is (`{ "bots": [ … ] }` for every
bot). Each checkup reads the bot's Bluesky profile, so the server allows 120
an hour; checking every bot waits out a short `Retry-After` and stops,
naming the bots left, when the wait would be over a minute.

### The listing

Deploy tokens accept a DID or a full handle; a full handle is resolved through
the public API without sending the token. They never enumerate your bots. CLI
tokens retain the short-name and previous-handle forms. `whoami` shows the token
type, scopes and bound bot when the server reports them.

`listing set` reads the listing first and sends only the fields that differ,
or nothing ("No change", exit code `0`): each change counts against a limit
of 30 an hour, shared with the dashboard.

```bash
bsbot listing set weather --listed --category weather --languages fr,en \
  --description "Hourly weather for Paris." --operator-name "Météo Lab"
bsbot listing set weather --file listing.json --dry-run
```

| Flag | Field |
| --- | --- |
| `--listed [true\|false]`, `--unlisted` | `listed` (bare `--listed` means true) |
| `--category <slug>`, `--category none` | `category` (none clears it) |
| `--description <text>`, `--no-description` | `description` |
| `--languages <code,code>` | `languages`, the main one first |
| `--recent-posts`, `--no-recent-posts` | `showRecentPosts` |
| `--operator <text>`, `--no-operator` | `operator.name` |
| `--show-operator`, `--hide-operator` | `operator.shown` |
| `--source-url <url>` | `sourceUrl` |
| `--open-source`, `--no-open-source` | `openSource` |
| `--support-url <url>` | `supportUrl` |

The original `--operator-name`, `--operator-shown` and `--operator-hidden` aliases remain supported.
An empty value (`--description ""`) also clears a field. `--file` takes a JSON
object with any of the fields of the listing, as `listing get --json` shows
them under `listing` (`usage` and `disclosure` included); the flags win over
the file. An unknown field is refused before anything is sent. The server
checks every value with the dashboard's rules and saves all or nothing; a
refused value prints its `field` and `reason`. `--dry-run` prints the
difference and stops.

A token from before the listing existed cannot read or change it: run
`bsbot login` again (`bsbot whoami` shows the token's scopes).

### In CI

Set `BSBOT_TOKEN` to a token, as a secret of your CI: commands use it instead
of the saved credentials, and never print it nor write it to disk. Today that
token is the one `bsbot login` saves (the `token` field of the credentials
file), valid 30 days. Passing the bot's DID saves a request. With GitHub
Actions:

```yaml
- run: npx --yes @blueskydotbot/cli listing set did:plc:… --file listing.json
  env:
    BSBOT_TOKEN: ${{ secrets.BSBOT_TOKEN }}
```

### The tools

`bsbot tool` lists the free tools of Bluesky.bot; `bsbot tool <slug>
key=value ...` runs one and prints its result (`--json`: the whole answer).
For example `bsbot tool did-finder handle=bsky.app`. Signed in, it sends your
token, which raises the limits tenfold; signed out, it works anonymously. See
https://bluesky.bot/docs/tools-api for each tool's parameters.

## Bugs and ideas

Found a bug or missing a command? Open an issue at
https://github.com/blueskydotbot/cli/issues with the version
(`bsbot --version`), the command and what it printed. Never paste your token.

## Security

`BSBOT_TOKEN` takes precedence over the credentials file. An explicitly empty
or malformed value fails instead of falling back to saved credentials.

- The token is saved in `~/.config/bsbot/credentials.json` (or
  `$XDG_CONFIG_HOME/bsbot/`, or `$BSBOT_CONFIG_DIR`), readable by you only.
  It lasts 30 days and is never printed, not even with `--json`.
- It can only manage your bots' handles, run their checkup and edit their
  directory listing: it cannot post, follow, read your Bluesky account or
  change your settings.
- `bsbot logout` revokes it; so does **Settings → CLI access** on
  bluesky.bot. A token given in `BSBOT_TOKEN` is not revoked by
  `bsbot logout`: revoke it in the settings.

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
