# AGENTS.md

Owner: Daniel Munoz (`me@danmunoz.com`)
Version: 1
Last updated: 2026-05-18

## Repo Purpose

This repository contains the public npm package for the TRMNL Token Meter CLI.
The package is a local Codex usage collector that uploads sanitized aggregate
usage snapshots to the hosted TRMNL Token Meter backend.

## Commands

- Install dependencies with `pnpm install`.
- Build with `pnpm build`.
- Test with `pnpm test`.
- Lint with `pnpm lint`.
- Privacy checks: `pnpm test:privacy`.
- Local CLI execution: `pnpm dev -- <command>`.

## Development Rules

- Keep raw Codex content local. Do not add uploads, logs, errors, or docs that
  expose prompts, responses, commands, file contents, diffs, repository names,
  absolute paths, API keys, pairing codes, or collector bearer tokens.
- Any aggregate payload change needs tests, privacy canaries, and README/docs
  updates in the same change.
- Keep the package publishable from the repository root. `package.json` should
  publish built `dist/` output only.
- Prefer small, focused modules and keep files under 500 LOC when practical.
- Use the existing pnpm/TypeScript/Vitest/ESLint toolchain unless the user
  explicitly approves a toolchain change.

## Git

- Run `git status` before editing and before committing.
- Do not rewrite history or force-push unless explicitly requested.
- Use Conventional Commits after the initial import.
