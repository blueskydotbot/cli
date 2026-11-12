# Changelog

All notable changes to the bsbot CLI (npm package `@blueskydotbot/cli`) are
listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/): the commands, their options,
the `--json` output, the exit codes and the minimum Node.js version are the
public interface.

## [Unreleased]

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
