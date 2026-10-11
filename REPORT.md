# Report

## Architecture

The system is one Node process, a CLI, and JSON files on disk. There are three paths through it:

- **Discovery** (`discover`): a model drives the app toward a goal and the run is recorded as a trace. A separate compiler then turns the trace into a capability.
- **Replay** (`replay`): runs a capability with typed inputs and no model. This is the production path an agent would call.
- **Escalation**: discovery and replay hand a live session to a person and get it back.

Everything above one interface, `Surface` (`observe`, `resolve`, `act`, `location`), is surface-agnostic. Discovery, replay, policy and the operator console never see a browser, a frame or a DOM node. `PlaywrightSurface` builds its element list from Chromium's accessibility tree for every frame and acts with real mouse and keyboard input on each element's on-screen box. No CSS selector is ever built.

Every action passes through `GuardedSurface`. It checks the control lease, then the policy gate, and only then calls the real surface. No code path can skip it.

I rejected services, queues and a database. The brief penalizes premature infrastructure, and one process lets the operator console drive the exact browser that automation was using. The cost is that a run cannot outlive its process. A production version would put the session in a remote browser and keep the same lease and state machine.

## Artifact schema

An artifact is three documents, all Zod schemas exported as JSON Schema in `/schemas`:

| Document       | Scope              | Holds                                                                                                                                                                  |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App profile    | one vendor product | fingerprint, tested versions, conditions that can appear on any screen (session expired, maintenance notice, permission denied, error page) and how to handle each     |
| Capability     | one flow           | the contract: typed inputs and outputs with sensitivity, preconditions, ordered steps, step-scoped business outcomes, a success checkpoint, risk, approval, provenance |
| Tenant overlay | one institution    | base URL, app version, label renames, version-scoped JSON patches, disabled capabilities, where its credentials come from                                              |

At load time the engine merges the three into an effective capability and logs its hash in every run.

A step names its intent, action, risk, whether it is safe to retry, a target, a value binding and an expected state. Targets are ordered locators: role and name, nearby label, visible text, structure, and a last-known bounding box. They describe what a desktop accessibility API can also answer. A step's value is always a binding (`inputs.memberId`, `secrets.operatorPassword`), never a recorded literal. A test fails if any demo input or secret appears in any artifact.

Screen states use one small matcher language everywhere: `all`, `any`, `not`, `visible`, `textPresent` and `locationMatches`. A reviewer can read a matcher, and the compiler can check one against recorded screens.

Approval binds a reviewer and a time to a content hash. Any edit changes the hash, so an edited artifact drops back to draft by itself. The model transcript is kept in evidence only. The artifact refers to it by run id and nothing more.

## Determinism & error handling

Replay is act, then classify. After every action the engine polls the screen and must recognise it before doing anything else. The classification order is fixed:

1. The step's expected state holds: go to the next step.
2. A business outcome scoped to this step matches: return it.
3. An app-profile condition matches: recover with a bounded number of attempts, return the outcome, or stop on a hard failure.
4. Nothing matches by the timeout: `UNEXPECTED_STATE`, which escalates.

The result contract keeps three things apart:

- `success`, with typed outputs (money as integer minor units).
- `business_outcome`, with a code and message. "No such member" is an answer, not a crash.
- `failure`, with a code, the step, what was expected, what was observed, whether it is retryable, and a masked screenshot plus an observation dump.

Recoverable conditions never surface as a status. They are handled in line and listed in `meta.recoveries`.

A locator counts only when it matches exactly one element. A fallback locator that hits is recorded as `locatorDrift`, the early signal that a tenant's UI moved. When nothing resolves, the step fails with `TARGET_NOT_FOUND` or `TARGET_AMBIGUOUS`. The engine never guesses. Member 10007 has two savings accounts, and replay refuses to pick one.

Two rules came from bugs the tests found:

- After a click, the engine waits for the screen to actually change before classifying, so it never re-reads the page it just left.
- Recovery that re-runs work checks that every step done so far is retry safe. Session expiry after Submit therefore escalates as `RETRY_UNSAFE` instead of silently submitting twice.

The limit: matchers are text and structure. A screen that looks right but holds stale data would pass. A production version would add data-level assertions per step.

## Heterogeneity & multi-tenant

**Surfaces.** The seam is `Surface`. A legacy web app is the case already implemented: framesets, layout tables and unlabeled inputs. The one rule that makes unlabeled controls targetable is geometric: the label is the closest text to the left on the same row, otherwise the closest text above. Geometry exists on every surface.

`DesktopSurface` implements the interface as a stub that maps each method to Windows UI Automation:

- control types map to the same role vocabulary
- `ValuePattern`, `InvokePattern` and `SelectionItemPattern` cover type, click and select
- `GridItemPattern` gives table rows and columns

The resolver, matchers, replay engine, policy gate and operator console would run unchanged on it.

**Tenants.** Knowledge about the product lives in the profile and capabilities. Tenant differences live in the overlay. Most differences between institutions on the same vendor product are renames, so the overlay's `textMap` rewrites whole label strings in locators and matchers at load time. Tenant B, with version 7.2, different labels, a reordered nav and a different brand, replays tenant A's capability with no patches.

When a rename is not enough, an overlay carries JSON Patch operations scoped to one capability and an app-version range. Drift is detected three ways:

- the app version read from the screen is compared with the tested versions (writes refuse to run on an untested version)
- locator fallbacks are recorded per step
- the effective hash says exactly which merged artifact ran

I did not build multi-tenant storage, cross-tenant drift dashboards or automatic overlay suggestions.

## Escalation & handoff

**Detecting "stuck".** Discovery is stuck when the model calls `stuck`, or when the same action repeats three times on a screen with the same hash. Replay is stuck on:

- `UNEXPECTED_STATE`
- `TARGET_NOT_FOUND` or `TARGET_AMBIGUOUS`
- `RECOVERY_EXHAUSTED`
- `RETRY_UNSAFE`

In discovery, an irreversible step raises an approval request instead.

**The request.** It carries the run, the capability or goal, the step and its intent, the reason code, expected versus observed, the location and a masked screenshot. It is saved to the run's folder and sent through a `Notifier`. The console notifier and the operator page are built. A webhook notifier is written but not wired in.

**Control transfer.** Control is a lease with exactly one holder, checked inside `GuardedSurface.act`, so automation and a human can never act at once. A per-session state machine moves the lease:

| From                  | Event               | To                    | Lease holder |
| --------------------- | ------------------- | --------------------- | ------------ |
| RUNNING               | escalate            | PAUSED_AWAITING_HUMAN | none         |
| PAUSED_AWAITING_HUMAN | take control        | HUMAN_CONTROL         | human        |
| HUMAN_CONTROL         | hand back           | RESUMING              | automation   |
| RESUMING              | resume check passes | RUNNING               | automation   |

Approve, reject, abort and timeout are the other exits.

The operator console runs in the process that owns the browser. A click on the live screenshot becomes `Surface.act({ type: 'pointer' }, 'human')` on the same session, and the same logger records it along with the element under the pointer. Typed text is logged as its length only, since it may be a secret.

**Resume is never blind.** "Retry" re-runs the step, and is offered only when that is retry safe. "Continue" first re-checks the step's expected state. A failed check goes back to the human once, then the run fails.

**Mocked on purpose.** Operator authentication, assignment among several operators, and streamed video. The CLI blocks while a human has control. A production caller would get an immediate `needs_human` handle and resume asynchronously against the same hub.

## Safety

There are two layers of enforcement:

- **The policy gate** checks every action in both discovery and replay: allowed action types, allowed origins and routes, and risk. `/app/admin` and `/__chaos` are blocked.
- **Network routing** aborts any request off the allowlist. This catches redirects and anything a harmless-looking click triggers. Clicking "Administration" is stopped here.

The allowlist binds the human operator too. Action-level risk checks do not, because the human is the authority being asked.

**Risk classes** are `read`, `reversible_write` and `irreversible`. A step's risk is the higher of its declared risk and a policy text hint (submit, confirm, transfer…), so hints can raise risk but never lower it.

- In discovery, an irreversible step always pauses for human approval.
- In replay, it runs only when the artifact is approved and the caller passed `--confirm-irreversible`. Otherwise the run stops with `POLICY_BLOCKED`.

**Data handling** follows each value's declared sensitivity:

| Sensitivity    | In logs                                     |
| -------------- | ------------------------------------------- |
| identifier     | last two characters                         |
| pii, financial | redacted                                    |
| secret         | never written; never returned to the caller |

On top of that:

- Every value a run touches (inputs, outputs, secrets) is registered and scrubbed from every log line and saved file.
- A pattern scrubber catches SSNs, account and card numbers, emails and money amounts.
- Saved screenshots get solid boxes over elements labelled sensitive.
- The model types secrets by name, so it never sees a password, and sign-on is replayed rather than discovered.

**Limits, plainly:**

- Discovery sends screen content to a model provider, so it must only run against synthetic or test records.
- Risk hints are text patterns. A destructive button with a bland label gets past them, which is why risk is reviewed at approval.
- Screenshot masking is a heuristic.
- The operator sees the live session unmasked.

## Cuts

- **The operator console is thin**: a polling page with screenshots twice a second, no authentication, a single operator, and a blocking CLI. The lease, the state machine and the human actions recorded through the surface are real.
- **Desktop is a stub.** The interface and the mapping are real. No UI Automation code runs.
- **Multi-tenant is files.** There is no tenant registry, no artifact storage service and no drift monitor. Overlays, version gating, drift signals and the effective hash are the parts I would keep.
- **Masking is heuristic**, driven by labels and patterns.
- **The evidence uses a scripted operator** to approve Submit and handle the unknown dialog. It is labelled as scripted.
- **Next**, in order:
  1. The approval gate with a reliability sidecar.
  2. Multi-run stability stats.
  3. A capability catalog that exposes approved capabilities as tool definitions.
  4. A bounded, single-step assisted fallback on `TARGET_NOT_FOUND` that proposes a locator patch for review instead of editing the artifact.
