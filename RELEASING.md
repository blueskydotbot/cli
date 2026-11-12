# Releasing

How a maintainer publishes `@blueskydotbot/cli` (the `bsbot` command). npm
publishing uses trusted publishing: no npm token is stored anywhere, and every
version is published by `.github/workflows/publish.yml` with provenance.

## Release a version

1. Make sure everything the new version needs on the bluesky.bot server is
   already live in production (see [API compatibility](#api-compatibility)).
2. On a branch, bump the version. This updates `package.json` and
   `package-lock.json` together:

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

   Rename the `## [Unreleased]` section of `CHANGELOG.md` to
   `## [0.2.0] - YYYY-MM-DD` and add a new empty `## [Unreleased]` above it.
   Put the most important entry first: the first bullets become the Bluesky
   announcement. A breaking change starts with **Breaking:**.
3. Open a pull request to `main`, wait for CI, merge.
4. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a v0.2.0 -m "bsbot 0.2.0"
   git push origin v0.2.0
   ```

5. In **Actions → Publish**, open the run of the tag, **Review deployments**,
   tick `npm`, **Approve and deploy**.

The workflow checks that the tag matches `package.json`, that `CHANGELOG.md`
has the section and that the commit is on `main`; it then tests on Node 22 and
24 and publishes. For a stable version that was actually published, it also
creates the GitHub Release `vX.Y.Z` (notes: the CHANGELOG section) and, when
the version became npm's `latest`, posts it on Bluesky as
[@cli.bluesky.bot](https://bsky.app/profile/cli.bluesky.bot). A failed post
only warns; it never fails the release. A version already on npm is skipped.

Check the result from a folder outside the repository:

```bash
npm view @blueskydotbot/cli dist-tags
npx --yes @blueskydotbot/cli@0.2.0 --version
npm init -y >/dev/null && npm install @blueskydotbot/cli@0.2.0 && npm audit signatures
```

`npm audit signatures` must report a verified attestation (the provenance).

### Re-run the release notes and the announcement

If the GitHub Release or the post is missing for a version already on npm,
run the workflow by hand **from that version's tag**:

```bash
gh workflow run publish.yml --repo blueskydotbot/cli --ref v0.2.0 -f version=0.2.0
```

It skips tests and publishing, creates the release if it is missing and posts
only if the account has not announced that version yet.

### Dist-tags

| Version | npm dist-tag |
| --- | --- |
| Pre-release (`0.3.0-rc.1`, tag `v0.3.0-rc.1`) | `next`, no GitHub Release, no post |
| Stable, newer than `latest` | `latest` |
| Stable, older than `latest` (a fix to an older line) | `release-X.Y`, GitHub Release without the *Latest* badge, no post |

Never point `latest` at a pre-release. The tag of a fix to an older line must
still be on `main`.

## Versioning

The public interface is: commands and options, the `--json` output and its
error format, exit codes (0, 1, 2), environment variables (`BSBOT_API_URL`,
`BSBOT_CONFIG_DIR`), the credentials file location and the minimum Node.js
version. Human-readable output is not. Removing or changing any of these is a
major change; while the version starts with `0.`, it bumps the minor version
and everything else bumps the patch. Dropping a Node.js version that reached
its end of life counts as breaking.

## API compatibility

The CLI talks to bluesky.bot: the `/cli/authorize` page,
`POST /api/v1/cli/token`, `/api/v1/me/*` and the public
`/api/v1/handles/{name}/availability` and `/api/v1/bots`. Published versions
stay on users' machines for years, so:

- the server only makes backwards-compatible changes to these endpoints; a
  breaking change goes to a new API version while the old one keeps working;
- the server change ships first, the CLI version that uses it second;
- every request sends `User-Agent: bsbot/<version>`, so the server knows
  which versions are still in use;
- the CLI prints the server's `error.message`, so the server can tell old
  versions to update without a new release.

## When a version is bad

A published version number is never reused. Fix forward, and deprecate:

```bash
npm deprecate @blueskydotbot/cli@0.2.0 "Login is broken in 0.2.0: use 0.2.1 or later."
npm dist-tag add @blueskydotbot/cli@0.1.1 latest   # only if the fix takes a while
```

Unpublish only to remove a secret or personal data from a tarball (and treat
the secret as leaked). npm allows it within 72 hours, later only under strict
conditions, and an unpublished version can never be republished. Never
unpublish the whole package and never delete the npm organization: the scope
keeps anyone else from publishing under `@blueskydotbot/`.

Security reports follow [SECURITY.md](SECURITY.md); a fix ships as a patch,
then older versions are deprecated and a GitHub security advisory is
published.

## Repository and account settings

### npm

- The `blueskydotbot` npm organization owns the package. Every member has
  two-factor authentication for sign-in and writes, and the package requires
  2FA and disallows tokens. `npm token list` shows no write token.
- Trusted publisher (package **Settings → Trusted Publisher → GitHub
  Actions**), allowed action **npm publish** only:

  | Field | Value |
  | --- | --- |
  | Organization or user | `blueskydotbot` |
  | Repository | `cli` |
  | Workflow filename | `publish.yml` |
  | Environment name | `npm` |

  Or `npm trust github @blueskydotbot/cli --repo blueskydotbot/cli --file publish.yml --env npm --allow-publish`,
  checked with `npm trust list @blueskydotbot/cli`. A new configuration
  expires if no successful publish uses it within 2 days, and a
  typo only shows at publish time (`ENEEDAUTH`). `repository.url` in
  `package.json` must name this repository exactly.

### GitHub environments

- `npm`: a required reviewer (a maintainer); deployment tags `v*` only.
- `bluesky`: deployment tags `v*` only, no reviewer. Secret
  `BLUESKY_APP_PASSWORD` (an app password of @cli.bluesky.bot, without access
  to direct messages), variable `BLUESKY_HANDLE` (`cli.bluesky.bot`), optional
  variable `BLUESKY_PDS_URL` (defaults to `https://bsky.social`).

Create both before the first release: a workflow that names a missing
environment creates it without any rule.

### Rulesets

- Tags `v*`: restrict creations, updates and deletions, with only the
  *Repository admin* role in the bypass list.
- Branch `main`: block force pushes and deletions, require a pull request and
  the `Node 22` and `Node 24` checks.

Also enable private vulnerability reporting, and require two-factor
authentication in the GitHub organization.

### Every year

Review npm and GitHub organization members and their 2FA, `npm token list`,
`npm trust list @blueskydotbot/cli`, the reviewers of the `npm` environment,
the rulesets, and the app password of @cli.bluesky.bot. Follow the Node.js
release schedule: keep `engines` and the CI matrices on the maintained LTS
versions.
