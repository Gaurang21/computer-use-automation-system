# Report

## Architecture

The system is one Node process with a CLI and JSON files on disk. **Discovery** lets a model drive the app toward a goal, and a separate compiler turns the recorded trace into a capability. **Replay** runs a capability with typed inputs and no model, which is the path an agent would call in production. **Escalation** lets either path hand the live session to a person and take it back.

The key boundary is the `Surface` interface (`observe`, `resolve`, `act`). Discovery, replay, policy and the operator console never touch a browser directly. The web implementation reads Chromium's accessibility tree for every frame and clicks and types with real input on each element's on-screen box. It never builds a CSS selector. Every action goes through `GuardedSurface`, which checks the control lease and then the policy gate, so no code path can skip either.

I chose one process over services and queues because the brief penalises early infrastructure, and because it lets the operator drive the exact browser the automation was using. The cost is that a run cannot outlive its process. In production the session would live in a remote browser, with the same lease and state machine.

## Artifact schema

A capability is spread over three documents, all Zod schemas exported as JSON Schema in `/schemas`:

- **App profile**, one per vendor product. It holds how to recognise the product, which versions were tested, and conditions that can appear on any screen, such as session expiry, maintenance notices, permission denial and error pages. Each condition says whether to recover, return a business outcome, or fail.
- **Capability**, one per flow. This is the contract an agent calls: typed inputs and outputs, each with a sensitivity level, preconditions, ordered steps, business outcomes scoped to a step, a success check, risk, approval and provenance.
- **Tenant overlay**, one per institution: base URL, version, label renames, version-scoped patches, and where that tenant's credentials come from.

Each step has an intent, a risk level, whether it is safe to retry, a target, a value binding and an expected screen state. The target is an ordered list of locators: role and name, nearby label, text, structure, then last known position. The value binding looks like `inputs.memberId` or `secrets.operatorPassword`. Recorded literals never enter an artifact, and a test fails if any input value or secret does.

One small matcher language describes screen states everywhere, so a reviewer can read it and the compiler can check it. Approval is tied to a content hash, so any edit sends the artifact back to draft. The model transcript stays in the evidence folder.

I split the artifact so that tenant differences never force a re-recording. The cost is a merge at load time, so every run logs the hash of what it actually ran.

## Determinism & error handling

Replay acts, then classifies the screen, and it never moves past a screen it does not recognise. The order is fixed:

1. The step's expected state holds: go on.
2. A business outcome for this step matches: return it.
3. An app condition matches: recover with a bounded number of attempts, return the outcome, or fail.
4. Nothing matches by the timeout: `UNEXPECTED_STATE`, which escalates.

The result is exactly one of three kinds:

- `success`, with typed outputs (money as integer cents)
- `business_outcome`, with a code and a message ("no such member" is an answer, not a crash)
- `failure`, with the step, what was expected, what was seen, whether to retry, and a masked screenshot

Recoveries are listed in `meta.recoveries`. They never count as a status.

A locator counts only when it matches exactly one element. A fallback locator that hits is recorded as drift. When nothing matches, the step fails with `TARGET_NOT_FOUND` or `TARGET_AMBIGUOUS` rather than guessing; member 10007 has two savings accounts, and replay will not pick one.

Two rules came from bugs:

- After a click, the engine waits for the screen to change, so it never misreads the page it just left.
- A recovery that would repeat work first checks that every step so far is safe to retry. Session expiry after Submit escalates as `RETRY_UNSAFE` instead of submitting twice.

The weakness is that matchers check text and structure, so a screen that looks right but holds stale data would pass.

## Heterogeneity & multi-tenant

**Surfaces.** The legacy web case is built: framesets, layout tables, and inputs with no labels. One geometric rule makes unlabelled inputs findable: the label is the closest text to the left, otherwise the closest text above. Every surface has geometry. `DesktopSurface` is a stub that maps each method to Windows UI Automation, and the resolver, matchers, replay, policy and console would run on it unchanged.

**Tenants.** Product knowledge lives in the profile and the capabilities. Tenant differences live in the overlay. Most differences between institutions on the same product are renamed labels, so the overlay rewrites whole label strings at load time. Tenant B has a different version, labels, navigation order and branding, and replays tenant A's capability with no patches. When a rename is not enough, a patch is scoped to one capability and a version range.

Drift shows up in three places:

- the app version on screen (writes refuse to run on an untested version)
- locator fallbacks
- the merged-artifact hash

The real runs showed the limit of renames. The model learned the not-found rule as "No member found for Member ID". Tenant B says "Account Holder No.", so a not-found there would escalate instead of returning the outcome. A one-line overlay patch fixes it, or a reviewer could shorten the rule. I did not build tenant storage or drift dashboards.

## Escalation & handoff

**When it escalates.**

- Discovery: the model calls `stuck`, or repeats the same action three times on an unchanged screen.
- Replay: an unrecognised screen, a missing or ambiguous target, a recovery that keeps failing, or a retry that is not safe.
- An irreversible step in discovery raises an approval request.

**The request.** It carries the run, the goal or capability, the step, the reason, expected versus observed, and a masked screenshot. It is saved with the run and sent through a `Notifier`.

**Who is in control.** Control is a lease with exactly one holder, checked inside `GuardedSurface`, so a person and the automation can never act at once. A state machine moves it from running to paused (nobody holds it), to human control, to resuming. Approve, reject, abort and timeout are the other exits.

The console runs in the process that owns the browser. A click on the live screenshot becomes `Surface.act(…, 'human')` on the same session and is logged with the element under the pointer. Typed text is logged as its length only.

**Handing back.** Resuming is never blind:

- "Retry" re-runs the step, and is offered only when that is safe.
- "Continue" first re-checks the step's expected state. If that fails, the run goes back to the person once, then fails.

The evidence shows this on a live session: an unknown dialog stopped replay, a scripted operator took over through the console API, clicked Acknowledge and handed back, and the run finished with `success`.

Operator login, routing between operators, and video are mocked. The CLI blocks while a person has control. A production caller would get a `needs_human` handle and resume later.

## Safety

Two layers enforce the allowlist:

- **The policy gate** checks every action, in discovery and replay, against allowed action types, origins, routes and risk.
- **Network routing** aborts any request off the list. This catches redirects and anything a harmless-looking click triggers.

The operator is bound by the allowlist too, but not by action-level risk checks, because they are the person being asked.

**Risk.** There are three levels: `read`, `reversible_write` and `irreversible`. A step's risk is the higher of what the artifact declares and a policy text hint such as "submit". In discovery, an irreversible step always waits for a person. In replay, it runs only if the artifact is approved and the caller passed `--confirm-irreversible`. Otherwise the run stops with `POLICY_BLOCKED`.

**Data.** Each value is handled by its sensitivity:

- identifiers show their last two characters in logs
- PII and financial values are redacted
- secrets are never written or returned

Every value a run touches is also scrubbed from every saved file. A pattern scrubber catches SSNs, account numbers, card numbers, emails and money. Screenshots get boxes over sensitive fields. The model types secrets by name and never sees them.

The real run caught one gap: transcripts were written before a member's name had been read. They are now written at the end of the run.

**Limits.**

- Discovery sends screens to a model provider, so it must run only on test data.
- Text hints miss a destructive button with a bland label, which is why risk is reviewed at approval.
- Masking is a heuristic.
- The operator sees the live screen unmasked.

## Cuts

What is thin:

- The operator console: it polls screenshots twice a second, with no login and one operator.
- Desktop: a stub.
- Multi-tenant: JSON files only, with no registry or drift monitor.
- Masking: driven by labels and patterns.
- The evidence uses a scripted operator for approval and handoff, labelled as such.

The first real run found two bugs:

- Probes and the self-check replayed an older saved file instead of the new draft.
- A leak check rejected "$25.00" because it contained the input "5.00".

Both are fixed and tested, and the evidence comes from the second run.

Next, in order:

1. An approval gate with a reliability score beside each capability.
2. Repeated replays to measure stability.
3. A catalog exposing approved capabilities as tool definitions.
4. A single-step, policy-checked model fallback on `TARGET_NOT_FOUND` that proposes a locator fix for review instead of editing the artifact.
