# Handoff status

**Current milestone:** 2 (surface and resolver)
**Model spend so far:** $0.00

## Milestones

| #   | Milestone                          | Status                                 |
| --- | ---------------------------------- | -------------------------------------- |
| 0   | Scaffold                           | done                                   |
| 1   | Target app                         | done                                   |
| 2   | Surface and resolver               | not started                            |
| 3   | Schemas, policy, redaction, logger | not started                            |
| 4   | Replay engine                      | not started                            |
| 5   | Discovery and compiler             | not started                            |
| 6   | Escalation                         | not started                            |
| 7   | Real evidence runs                 | not started, needs `ANTHROPIC_API_KEY` |
| 8   | Docs                               | not started                            |

## What works

- `npm run app` starts MemberDesk tenant A on :4000 and tenant B on :4001.
- Smoke test walks both flows over HTTP on both tenants and triggers every failure switch (16 tests).

## What fails

Nothing yet.

## Skipped and why

Nothing yet.

## Open questions

None.
