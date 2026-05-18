# Releasing

This package is published from GitHub Actions.

## Prerequisites

- `main` is protected and green
- npm trusted publishing is configured for this GitHub repository
- The GitHub environment used for npm release, if configured, is protected with reviewer approval
- [CHANGELOG.md](../CHANGELOG.md) is updated

## Process

1. Merge the release-ready changes to `main`.
2. Confirm CI is green on Node `22.13.0` and `24`.
3. Update `CHANGELOG.md` for the release.
4. Run the `Release` workflow from `main` and provide the target semver.
5. Verify the workflow completed the version commit, tag push, tarball smoke test, and npm publish with provenance.

## Notes

- Releases are intentionally blocked off non-`main` refs.
- The workflow publishes only the packed artifact surface: `LICENSE`, `README.md`, `package.json`, and `dist/`.
- `pnpm test:pack` is the local and CI smoke test for the packed CLI.
