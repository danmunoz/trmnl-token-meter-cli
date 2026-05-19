# Releasing

This package is published from GitHub Actions using a release PR flow driven by
`release-please`.

## Prerequisites

- `main` is protected and green
- npm trusted publishing is configured for this GitHub repository
- Repository Settings > Actions > General allows GitHub Actions to create pull requests
- A `RELEASE_PLEASE_TOKEN` secret is configured if you want CI checks to run on release PRs created by automation
- The GitHub environment used for npm release, if configured, is protected with reviewer approval

## Process

1. Merge a release-worthy PR to `main`.
2. The `Release` workflow runs on that push and opens or updates a release PR with the next semver and `CHANGELOG.md` changes.
3. Review that release PR like any other PR.
4. Merge the release PR when you want to ship.
5. The next `Release` workflow run publishes to npm automatically after it confirms the release was created, the tarball still passes `pnpm prepublishOnly`, `npm pack --dry-run`, and `pnpm test:pack`, and provenance publishing succeeds.

## Notes

- Releases are intentionally blocked off non-`main` refs.
- Release notes and version bumps come from Conventional Commits on merged PRs.
- `release-please` updates `CHANGELOG.md`, `package.json`, and the release tag for you.
- Without `RELEASE_PLEASE_TOKEN`, automation still works, but PRs and tags created with `GITHUB_TOKEN` will not trigger additional GitHub workflows.
- The workflow publishes only the packed artifact surface: `LICENSE`, `README.md`, `package.json`, and `dist/`.
- `pnpm test:pack` is the local and CI smoke test for the packed CLI.
