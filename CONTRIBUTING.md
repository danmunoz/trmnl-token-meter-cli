# Contributing

## Development Setup

1. Install Node `22.13.0` or newer.
2. Install dependencies with `pnpm install`.
3. Run the verification suite:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:privacy
pnpm test:pack
```

## Change Expectations

- Keep privacy guarantees intact. Do not add uploads, logs, or docs that expose prompts, responses, commands, diffs, file contents, repository names, absolute paths, pairing codes, collector tokens, or other secrets.
- If you change aggregate payload shape, update tests and docs in the same change.
- Prefer small, focused patches and keep modules under roughly 500 lines when practical.
- Add regression tests for bug fixes when the failure mode is testable.

## Pull Requests

Please include:

- What changed
- Why it changed
- How it was verified
- Any privacy or compatibility impact

## Release Notes

User-visible changes should be reflected in [CHANGELOG.md](./CHANGELOG.md).
