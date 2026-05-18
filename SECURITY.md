# Security Policy

TRMNL Token Meter handles local usage aggregates and collector credentials. Please report security issues privately.

## Supported Versions

Security fixes are applied to the current `main` branch and the latest published npm release.

## Reporting

Email: `me@danmunoz.com`

Please include:

- A clear description of the issue
- Reproduction steps or a proof of concept
- Expected impact
- Any suggested mitigation

Do not open public GitHub issues for credential leaks, privacy boundary failures, or backend trust issues.

## Response Expectations

- Initial acknowledgement target: within 5 business days
- Triage outcome target: within 10 business days
- Fix timing depends on severity and blast radius

## Scope

Relevant classes of issues include:

- Uploading or logging raw Codex content
- Leaking collector tokens, pairing codes, or local paths
- Trust boundary failures in pairing or upload flows
- Supply-chain or release integrity problems
