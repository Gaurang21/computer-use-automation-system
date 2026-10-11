# Computer-use automation system

An LLM drives a legacy back-office UI once. What it did is compiled into a typed, versioned **capability**. That capability then replays deterministically, with no model in the loop, and returns typed outputs, a known business outcome, or a debuggable failure. When replay or discovery gets stuck, a human operator takes over the same live browser session and hands it back.

The target is **MemberDesk**, a fictional teller back-office for an invented credit union, built to be hostile: a frameset, tables nested three deep, no ids, no ARIA, no `<label for>`, and opaque field names. It runs as two tenants of the same vendor product on different versions with different labels.

The design write-up is in [`REPORT.md`](REPORT.md). Every decision and the alternative it beat is in [`DECISIONS.md`](DECISIONS.md). Evidence of real runs is in [`evidence/`](evidence/).

## Setup

You need Node 22.12 or newer.

```bash
npm install
npx playwright install chromium
cp .env.example .env        # then fill in ANTHROPIC_API_KEY for real discovery runs
```

`.env` holds these variables:

| Variable                                                 | Used for                                                                                       | Default                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| `ANTHROPIC_API_KEY`                                      | Discovery only. Replay never calls a model.                                                    | none                                |
| `CUA_MODEL`                                              | Model for the discovery agent                                                                  | `claude-sonnet-5-5`                 |
| `MAX_SPEND_USD`                                          | Hard spend cap per discovery run. The run aborts when it passes.                               | `1.00`                              |
| `MEMBERDESK_OPERATOR_ID`, `MEMBERDESK_OPERATOR_PASSWORD` | Synthetic sign-on credentials for the local app. Replay reads them through the tenant overlay. | `teller01` / `change-me-local-only` |

All member data is synthetic.

## Demo path

Start the target app in its own terminal. Tenant A runs on :4000 and tenant B on :4001.

```bash
npm run app
```

**1. Discover a goal.** A model signs on (replayed, no model spend), finds the member, and reads the name and savings balance. The run is compiled into a capability. A probe run with member 99999 teaches the capability the `MEMBER_NOT_FOUND` outcome. A self-check replay must pass before anything is saved.

```bash
npm run discover -- --spec goals/member.lookup_savings_balance.json
```

The capability is written to `capabilities/memberdesk/member.lookup_savings_balance.json`, and the run's evidence to `runs/<run id>/`.

**2. Replay it with inputs. No model is called.**

```bash
npm run replay -- --capability member.lookup_savings_balance --input memberId=10003 --allow-draft
```

The result JSON goes to stdout. Exit codes are 0 for success, 10 for a business outcome and 20 for a failure.

**3. Replay with a bad ID: a business outcome, not a crash.**

```bash
npm run replay -- --capability member.lookup_savings_balance --input memberId=99999 --allow-draft     # MEMBER_NOT_FOUND, exit 10
npm run replay -- --capability member.lookup_savings_balance --input memberId=12 --allow-draft        # INVALID_INPUT, the UI is never touched
```

**4. The same capability on tenant B** (version 7.2, "Account Holder No.", "Find", "Share Savings"). Only the overlay is applied:

```bash
npm run replay -- --capability member.lookup_savings_balance --input memberId=10001 --tenant tenant-b --allow-draft
```

**5. Trigger an escalation and take over the live session.** Arm a page that no artifact knows about, then replay:

```bash
curl -X POST localhost:4000/__chaos -H 'content-type: application/json' -d '{"switch":"unknownDialog","path":"/app/search"}'
npm run replay -- --capability member.lookup_savings_balance --input memberId=10001 --allow-draft
```

Replay stops at the unknown screen, prints an intervention request, and blocks. Open the operator console at <http://localhost:4100> and do the following:

1. Click **Take control**.
2. Click **Acknowledge** on the live screen.
3. Click **Hand back: retry the step**.

The run then finishes with `success`, and the intervention is listed in `meta.humanInterventions`. Your actions appear in the run's `run.jsonl` as `actor: "human"` events.

Other failure switches for `/__chaos` are `interstitial`, `expireSession`, `slow` (with `"ms"`) and `error500`. Add `"persist": true` to fire on every request. `DELETE /__chaos` clears them all.

**6. The irreversible flow.** Discovering `member.open_sub_account` pauses at Submit until someone approves it in the console:

```bash
npm run discover -- --spec goals/member.open_sub_account.json
```

Replaying past Submit needs an approved artifact plus explicit caller confirmation:

```bash
npm run approve -- --capability member.open_sub_account --by "<reviewer>"
npm run replay -- --capability member.open_sub_account --confirm-irreversible \
  --input memberId=10002 --input accountType="Money Market" --input nickname="Rainy day" --input openingDeposit=150.00
```

Without either one, the run stops at Submit with `POLICY_BLOCKED`.

### Running with no API key

Add `--llm fake` to `discover`. A scripted model, defined in the goal spec's `fake` block, makes the same tool calls a real model would, against the live app. Everything after the model works exactly the same: compiler, probes, self-check and replay.

```bash
npm run discover -- --spec goals/member.lookup_savings_balance.json --llm fake
```

`npm run evidence -- --llm fake` dry-runs the whole evidence set into `runs/evidence-fake/`. It never writes to `evidence/`.

### Regenerating the evidence

```bash
npm run evidence
```

This needs `ANTHROPIC_API_KEY`. It starts both tenants on free ports and runs both real discoveries. In those runs, a scripted operator approves Submit through the console API, and it is labelled as scripted everywhere. The script then runs every replay case and rewrites `evidence/`. Spend is capped per run by `MAX_SPEND_USD`, and the script stops before the total passes $5.

## Tests

```bash
npm test          # unit and end-to-end tests: real browser, real app, fake LLM
npm run check     # typecheck, lint and tests
```

The end-to-end tests cover:

- every result status
- every failure switch
- discovery with the fake LLM followed by replay of what it compiled
- the scripted operator handoff: take control, click, hand back, resume
- the lease rejecting the wrong actor
- the leak check, which fails if any input value or secret appears in an artifact

## What is mocked, and where the seam is

| Mocked                            | Why                                                | The seam                                                                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The bank app                      | No real bank system is available or appropriate    | `target-app/` is a separate Express app. The system only reaches it through a browser.                                                                                                                                                                 |
| The desktop surface               | One concrete surface is enough to prove the design | `src/surface/desktop.ts` implements `Surface` and throws. Each method maps to Windows UI Automation.                                                                                                                                                   |
| The operator console              | A real co-browsing console is out of scope         | `src/operator/` serves a plain page from the process that owns the session. The lease, the state machine and the human actions through `Surface.act(…, 'human')` are real. Operator auth, multi-operator assignment and video streaming are not built. |
| The "human" in tests and evidence | No person is available in CI                       | A scripted operator drives the console's HTTP API, and it is labelled everywhere it appears                                                                                                                                                            |
| The LLM, when there is no key     | The whole path should run for free                 | `src/discovery/fake-brain.ts` implements the same `Brain` interface as `anthropic-brain.ts`                                                                                                                                                            |
| Multi-tenant storage              | The brief rewards design, not infrastructure       | Capabilities, profiles and overlays are JSON files. `CapabilityStore` is the one place that would change.                                                                                                                                              |

## Layout

```
target-app/        MemberDesk (Express, server-rendered), two tenants, /__chaos switches
src/surface/       Surface interface, PlaywrightSurface (accessibility tree), resolver, DesktopSurface stub
src/schema/        Zod schemas: target, matcher, capability, app profile, overlay, policy, result
src/policy/        policy gate, GuardedSurface (lease + gate), redaction and masking
src/replay/        replay engine, classification, store and overlay merge, inputs and outputs, approval
src/discovery/     agent loop, Anthropic and fake brains, compiler, probes, spend cap
src/session/       control lease and state machine
src/operator/      operator hub, console page and API, escalation adapters
src/evidence/      run logger, evidence generator
capabilities/      app profile, auth.login, tenant overlays, discovered capabilities
goals/             discovery goal specs (typed inputs, outputs, probes, fake script)
policy/            default.policy.json
schemas/           exported JSON Schema for every artifact and the result contract
tests/             unit and end-to-end tests, fixtures (hand-written capabilities)
docs/              the brief and the build plan
```
