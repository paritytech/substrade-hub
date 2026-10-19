# Security policy

## Security status

SubsTrade Hub is reference and demo code for an on-chain order book on Polkadot Asset Hub. Its
contracts are deployed on test networks only. It is not intended as a production-ready artefact.

The code went through two security reviews in October 2026. Their findings are tracked as GitHub
issues with the `security` label, each with its severity. This is not a full independent audit: use in
production or production-like deployments should only follow an independent security review of the
code, its configuration and the deployment environment.

Known limitations and accepted trade-offs are listed in [KNOWN_ISSUES.md](KNOWN_ISSUES.md), and the
admin's powers in [contracts/docs/admin.md](contracts/docs/admin.md).

## Supported versions

Security fixes go to the `master` branch and ship in the next `dot-v*` release. Older releases are not
patched.

## Bug bounty

This repository is not in scope for Parity's paid bug bounty programme unless it is listed in the
official bounty scope at the time of submission. Reports are still reviewed through responsible
disclosure.

## What to report

Report an issue if it shows realistic impact on:

- user funds or assets held by the contracts;
- order matching, escrow or settlement integrity;
- private keys, signing flows, or what a user is asked to sign;
- the published app (its build, publishing or the dotNS name it is served from);
- remote code execution or credential compromise in a realistic deployment.

Out of scope, unless shown to cause realistic high-impact harm: issues only affecting local development
or the demo bootstrap; limitations documented in [KNOWN_ISSUES.md](KNOWN_ISSUES.md); dependency reports
without a working exploit path; and reports that the code is unaudited.

## Reporting a vulnerability

Do **not** open a public issue for a vulnerability. Email **security@parity.io** with:

- the affected commit, branch or release;
- clear reproduction steps and the realistic impact;
- any proof of concept;
- the assumptions the exploit needs.

Please do not test against systems you do not own beyond what is needed to show impact, and do not
disclose publicly before Parity has had a reasonable opportunity to fix the issue.
