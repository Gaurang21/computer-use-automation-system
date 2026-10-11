# Handoff status

**Current milestone:** 5 (discovery and compiler)
**Model spend so far:** $0.00

## Milestones

| #   | Milestone                          | Status                                 |
| --- | ---------------------------------- | -------------------------------------- |
| 0   | Scaffold                           | done                                   |
| 1   | Target app                         | done                                   |
| 2   | Surface and resolver               | done                                   |
| 3   | Schemas, policy, redaction, logger | done                                   |
| 4   | Replay engine                      | done                                   |
| 5   | Discovery and compiler             | not started                            |
| 6   | Escalation                         | not started                            |
| 7   | Real evidence runs                 | not started, needs `ANTHROPIC_API_KEY` |
| 8   | Docs                               | not started                            |

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
- `DesktopSurface` stub implements the interface and maps each method to Windows UI Automation.

## What fails

Nothing yet.

## Skipped and why

Nothing yet.

## Open questions

None.
