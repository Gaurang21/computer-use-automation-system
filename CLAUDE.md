# Project instructions

Read docs/PLAN.md before doing anything. It is the build plan.
docs/brief.pdf is the original assignment and wins any conflict.

- Follow the milestone order in section 12 of the plan. Pass a milestone's checks before starting the next.
- The decisions in section 2 are locked. For anything the plan leaves open, decide and add one line to DECISIONS.md.
- Work in phases (one per milestone). Before every commit, show the files and the commit message and wait for a go-ahead.
- Commit directly to main. Small commits with plain, meaningful messages, no prefixes.
- Update HANDOFF_STATUS.md at the end of every milestone: what passes, what fails, model spend so far.
- Run `npm run check` (typecheck, lint, tests) before every commit.
- Develop with --llm fake. Real model calls happen only in milestone 7 and stay under the spend cap.
- Never commit secrets, real credentials or real PII. Never fabricate evidence.
- Stretch goals in section 11 start only after the core (milestones 0-8) works.
