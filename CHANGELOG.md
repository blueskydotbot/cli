# Changelog

All notable changes to the bsbot CLI (npm package `@blueskydotbot/cli`) are
listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/): the commands, their options,
the `--json` output, the exit codes and the minimum Node.js version are the
public interface.

## [Unreleased]

## [0.2.0] - YYYY-MM-DD

### Added

- `bsbot doctor` runs your bot's checkup, with a link to fix each problem.
  It checks the Automation label, bio, avatar, description, operator line,
  handle and listing of one bot, or of every bot (`--strict`, `--verbose`),
  and exits with `3` when a check fails, for scripts and CI.
- `bsbot listing` reads and edits a bot's directory listing, from a terminal
  or a CI job. `listing set` takes flags or `--file listing.json`, sends only
  the fields that differ (nothing when none does), and `--dry-run` shows the
  difference.
- `BSBOT_TOKEN` gives a token to use instead of the saved one, for CI.
- `bsbot tool` lists the free tools of Bluesky.bot, and
  `bsbot tool <slug> key=value ...` runs one, with higher limits when you
  are signed in.
- `bsbot whoami` shows what the token may do (its scopes), when the server
  says.
- `--json` errors carry the server's `field`, `reason`, `parameter` and
  `scope` when it sends them.

### Changed

- A token that lacks a permission (`403 insufficient_scope`) prints the
  server's message and asks you to run `bsbot login` again.

## [0.1.1] - 2026-11-12

### Changed

- Source code, issues and pull requests are now on
  [github.com/blueskydotbot/cli](https://github.com/blueskydotbot/cli).
- Published from there with npm provenance, and a GitHub Release for each
  stable version.
- The package's repository and issue links point to the new repository (it
  was renamed from blueskydotbot/bsbot-cli).

## [0.1.0] - 2026-11-12

### Added

- `login` through the browser (OAuth for native apps with PKCE), `logout`
  and `whoami`.
- `bots`, `check`, `claim`, `switch`, `verify` and `release` for your bots'
  `name.bluesky.bot` handles.
- `directory` to browse the public bot directory.
- `--json` output on every command, `--api-url` and `BSBOT_API_URL`.
- Node.js 22 or later, macOS and Linux, no runtime dependency.
