# Handoff status

> **Milestone 7 is done.** `evidence/` comes from a real run on `claude-sonnet-5-5` (commit `b1ef053`, $0.13). An earlier run (`bbf4e54`, $0.12) exposed two bugs, fixed in `d692742` and `4c0e8d4`.

**Current milestone:** core milestones 0-8 done. Stretch goals (9) not started.
**Model spend so far:** $0.25 (two real evidence runs: $0.12 + $0.13)

## Milestones

| #   | Milestone                          | Status |
| --- | ---------------------------------- | ------ |
| 0   | Scaffold                           | done   |
| 1   | Target app                         | done   |
| 2   | Surface and resolver               | done   |
| 3   | Schemas, policy, redaction, logger | done   |
| 4   | Replay engine                      | done   |
| 5   | Discovery and compiler             | done   |
| 6   | Escalation                         | done   |
| 7   | Real evidence runs                 | done   |
| 8   | Docs                               | done   |

## What works

- `npm run app` starts MemberDesk tenant A on :4000 and tenant B on :4001.
- Smoke test walks both flows over HTTP on both tenants and triggers every failure switch.
- `PlaywrightSurface` observes all four frames through the accessibility tree, resolves an unlabeled input in the main frame by its label anchor, reads table cells by row predicate and column, and returns every candidate for an ambiguous target.
- Zod schemas for the app profile, capability, tenant overlay and run result validate every artifact. JSON Schema is exported to `/schemas`.
- The policy gate blocks the admin route, `/__chaos` and off-origin navigation, and pauses irreversible steps. Network routing aborts blocked requests that a click triggers.
- Redaction covers sensitivity levels, pattern scrubbing and known-value scrubbing. Screenshots are masked. The leak test checks that no demo input appears in any artifact.
- Replay engine, tested end to end with hand-written capabilities:
  - success with typed outputs (money as minor units), on both tenants through the overlay
  - business outcomes: `MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `NO_SAVINGS_ACCOUNT`, `DEPOSIT_BELOW_MINIMUM`
  - recovered in line: interstitial, session expiry (re-login and restart), slow load
  - failures: `INVALID_INPUT` (UI never touched), `APP_ERROR` with masked screenshot and observation, `UNEXPECTED_STATE`, `RECOVERY_EXHAUSTED`, `TARGET_AMBIGUOUS`, `RETRY_UNSAFE` (session expiry mid-submit), `POLICY_BLOCKED`, `NOT_APPROVED`, `MISSING_SECRET`
- `npm run replay` and `npm run approve` work from the CLI, with exit codes 0/10/20.
- Discovery runs end to end with `--llm fake`. Sign-on is replayed, then the agent loop runs, the compiler builds the capability, a probe adds `MEMBER_NOT_FOUND`, and the self-check replay passes. The saved capability replays for other members. No literal input appears in it.
- `AnthropicBrain` is ready (strict tools, spend cap, redacted transcript) but has not made a real call yet. That needs `ANTHROPIC_API_KEY` (milestone 7).
- Escalation and handoff: replay and discovery raise intervention requests to an operator console on :4100, served by the process that owns the browser. The scripted operator test takes control of the live session, clicks Acknowledge on the unknown dialog, hands back with retry, and the run finishes with `success` and the intervention listed in `meta`. A wrong-actor action is rejected by the lease. Human actions appear in `run.jsonl`. A failed resume check re-escalates once, then fails. Abort and timeout are covered. Discovery pauses at Submit until a human approves.
- `DesktopSurface` stub implements the interface and maps each method to Windows UI Automation.

## What fails

Nothing in the core.

Two limits that the evidence shows:

- **A tenant-specific matcher.** The model-learned outcome matcher for `MEMBER_NOT_FOUND` is `"No member found for Member ID"`. On tenant B the label reads "Account Holder No.", and `textMap` only renames whole strings, so that outcome would not be recognised there. A not-found replay on tenant B would escalate instead. The fix is a one-line overlay patch, or a shorter matcher such as "No member found" chosen at review time. This is the per-tenant drift the overlay exists for.
- **An expectation from a diff.** For step s4 of the open sub-account flow, the model's expected text did not verify, and the compiler fell back to a text diff ("Member:").

## Skipped and why

- Stretch goals (milestone 9): not started, by request, until the core including real evidence is done.

## Verified on a fresh clone

`npm ci`, `npm run app`, then every command in the README demo path:

- discover with `--llm fake`
- replay with success, `MEMBER_NOT_FOUND` and `INVALID_INPUT`
- tenant B
- the unknown-dialog escalation, handled through the console API (take control, click Acknowledge, hand back with retry), finishing with `success`
- open sub-account discovery with approval at Submit
- `POLICY_BLOCKED` without approval or without confirmation, then success after `approve` plus `--confirm-irreversible`

## Open questions

None.
