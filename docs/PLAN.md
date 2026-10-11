# Build plan: interface.ai Computer-Use Take-Home

The original assignment is in [`docs/brief.pdf`](brief.pdf) and wins any conflict with this plan.

## 1. Mission and working rules

Build a small working system that lets an LLM drive a legacy bank UI once, saves what it learned as a typed capability, and replays that capability with no model in the loop.

The thread that must run end to end: a goal, a real LLM-driven run, a saved artifact, a deterministic replay with inputs, outputs and error handling, a human escalation that takes over the live session, and evidence for all of it.

**How to work**

- Where this plan is silent, decide and add one line to `DECISIONS.md`: the choice, the alternative rejected, and why.
- Build order follows section 12. The core slice comes before any stretch goal. A thin real version of every requirement beats polish on a few.
- The brief ranks system design first, then core loop correctness, error handling, human escalation, generalization, safety, code quality, write-up. Breadth, framework name-dropping and scaling infrastructure earn nothing. So no queues, no database, no Docker, no microservices.
- Spend time on the error taxonomy before locator cleverness. The brief says the UIs are stable and runtime errors are the hard part.
- Every design choice must be defensible out loud. Prefer the simple mechanism that can be explained over the smart one that cannot.

**Budget**

- Total LLM spend across the whole project stays under $5.
- Enforced in code: read token usage from each API response, keep a running total per run in `usage.json`, abort the run when it passes `MAX_SPEND_USD` (default 1.00).
- Build and test the agent loop against a fake LLM that returns a scripted list of tool calls. Real API calls are only for the evidence runs in milestone 7.

**Hard rules**

- Never fabricate evidence. If the API key is missing or the network blocks the API, finish everything else against the fake LLM, leave `npm run evidence` ready, and say so at the top of `HANDOFF_STATUS.md`.
- No secrets in the repo. The key comes from `ANTHROPIC_API_KEY` in the environment. Commit `.env.example`, gitignore `.env`.
- No real credentials and no real PII anywhere. All member data is synthetic.
- Treat every commit as public.
- Small commits with plain messages, pushed as you go.

## 2. Locked decisions

| Area | Choice | Rejected, and why |
|---|---|---|
| Language | TypeScript in strict mode, Node 22+, npm | Python. TypeScript and Playwright are the daily tools here, and every line has to be defensible. |
| UI driver | Playwright with Chromium | Selenium and Puppeteer. Weaker frame handling and waiting. |
| Schemas | Zod, with JSON Schema exported from it | Hand-written interfaces. No runtime validation, no schema a calling agent can read. |
| Model | Anthropic API. Model id from `CUA_MODEL`, default `claude-sonnet-5-5` | A hosted agent SDK. It hides the loop the graders want to see. |
| Tooling for the model | Our own tool definitions that act on numbered elements | The provider's built-in computer-use tool. It ties us to one vendor and to pixel coordinates. |
| Perception | Accessibility tree plus a screenshot | Raw DOM selectors do not exist on desktop. Pure pixels cannot give stable replay targeting. |
| Target | A local mock back-office app, built to be hostile | A public demo site. No control over failure modes, and terms of use risk. |
| Architecture | One Node process, a CLI, JSON files on disk | Services and queues. The brief penalizes premature infrastructure. |
| Operator surface | A local web console that drives the same session through the same Surface interface | A headed browser the human clicks in directly. It fails headless, fails for remote sessions, and needs DOM hooks to record the human. |
| Tests | Vitest | Jest. Slower setup for TypeScript. |

Artifacts contain no CSS or XPath selectors at all. A selector is a web-only idea. Targets are described by role, name, nearby label and structure, which a desktop accessibility API can also answer.

## 3. Repo layout and commands

```
/README.md
/REPORT.md
/DECISIONS.md
/HANDOFF_STATUS.md
/evidence/
/capabilities/        app profiles, capabilities, tenant overlays (JSON)
/policy/              default.policy.json
/target-app/          the mock bank app (Express, server-rendered)
/src/
  surface/            Surface interface, PlaywrightSurface, GuardedSurface, DesktopSurface stub
  schema/             Zod schemas and JSON Schema export
  discovery/          agent loop, LLM client, fake LLM, compiler, probes
  replay/             engine, target resolver, state matchers, result types
  policy/             gate, risk classes, redaction
  session/            control lease and state machine
  operator/           operator console server and page
  evidence/           run logger
  catalog/            stretch
  cli.ts
/tests/
```

Commands exposed through npm scripts:

```
npm run app                 start tenant A on :4000 and tenant B on :4001
npm run discover -- --goal "..." --target http://localhost:4000 --name member.lookup_savings_balance --input memberId=10042 --probe memberId=99999
npm run replay -- --capability member.lookup_savings_balance --input memberId=10042 [--tenant tenant-b]
npm run operator            operator console on :4100 (also starts with any run that may escalate)
npm run approve -- --capability <id> --by <name>
npm run evidence            regenerate every folder under /evidence
npm test
```

`discover` accepts `--llm fake` so the whole path runs with no API key.

## 4. Target app

A fictional product called MemberDesk, the teller back-office of the invented Cedar Valley Credit Union. It looks and behaves like a 2004 enterprise web app. One Express codebase serves two tenants from one config object.

**Hostility requirements**

- A frameset with a banner frame, a navigation frame and a main frame. Fall back to nested iframes only if Chromium gives trouble.
- Table-based layout, nested at least three deep. No ids, no classes with meaning, no test ids, no ARIA.
- Inputs have no `<label for>`. The label is plain text in the neighboring table cell. Field `name` attributes are opaque (`f1`, `f2`).
- Full page posts, server-rendered responses. A footer line shows product name and version, for example `MemberDesk v7.4`.

**Screens**

1. Login with operator id and password. Synthetic credentials, read from the target app's config.
2. Member search by member ID.
3. Member detail: name, masked SSN, an accounts table with type, account number and balance.
4. Open sub-account form: account type select, nickname, opening deposit.
5. Review screen showing what will be created, with a Submit button.
6. Confirmation screen with the new account number.
7. An admin area linked from the nav. The policy blocks it. It exists to prove the block.

**Seed data.** Eight synthetic members, IDs 10001 to 10008. One has no savings account. One is restricted and returns a permission denial.

**The two flows we automate**

- `member.lookup_savings_balance`: search a member, read name and savings balance. Read-only.
- `member.open_sub_account`: fill the form and reach the review screen. The final Submit is the irreversible step.

**Failure switches.** A control endpoint outside the frameset, `POST /__chaos`, arms one-shot or persistent conditions. The agent never sees this endpoint and the policy does not allow it.

| Switch | Effect | Expected class |
|---|---|---|
| built in | Unknown member ID shows "No member found" | business outcome |
| built in | Restricted member shows "You are not authorized" | business outcome |
| built in | Deposit under the minimum shows a validation message | business outcome |
| `interstitial` | A maintenance notice page with a Continue button | recoverable |
| `expireSession` | Next request lands on login with "Your session has expired" | recoverable |
| `slow=<ms>` | Delays responses | recoverable by waiting |
| `error500` | An application error page | hard failure |
| `unknownDialog` | A page no artifact knows about, with an Acknowledge button | unexpected state, escalates |

**Tenant B.** Same product, version 7.2, different skin. "Member ID" becomes "Account Holder No.", "Savings" becomes "Share Savings", the Search button says "Find", the nav order changes, the banner branding changes. No behavior changes. This is the stand-in for two institutions running one vendor product.

## 5. Surface abstraction and locators

The seam the brief asks about is one interface. Everything above it (discovery, replay, policy, operator console) knows nothing about browsers.

```ts
interface Surface {
  kind: 'web' | 'desktop'
  observe(): Promise<Observation>
  resolve(target: TargetSpec): Promise<ObservedElement[]>
  act(action: Action, actor: 'automation' | 'human'): Promise<void>
  location(): Promise<string>
}

interface Observation {
  location: string
  screenshot: Buffer
  elements: ObservedElement[]
  hash: string
}

interface ObservedElement {
  ref: string
  role: string
  name: string
  value?: string
  nearText?: { text: string, relation: 'left_of' | 'above' }
  framePath: string[]
  bbox: { x: number, y: number, w: number, h: number }
  states: string[]
}
```

`PlaywrightSurface` builds the element list from the accessibility tree of every frame. Use CDP `Accessibility.getFullAXTree` per frame or Playwright's aria snapshot, whichever handles the frameset cleanly, and log the choice. For inputs with an empty accessible name, compute `nearText` from geometry: the closest text to the left on the same row, else the closest above. That one rule is what makes unlabeled legacy forms targetable.

`DesktopSurface` is a stub that implements the interface and throws. A comment in it maps each method to Windows UI Automation. That is enough to show the seam is real.

**Actions.** `click`, `type`, `select`, `press`, `read`, `wait`, `goto`. Plus two low-level ones, `pointer(x, y)` and `key`, which only the human actor may use.

**TargetSpec.** An ordered list of locators, tried in order:

1. `role_name`: role plus exact accessible name.
2. `label_anchor`: role plus the nearby label text and its relation.
3. `text`: visible text, for buttons and links.
4. `structural`: frame path, role, and ordinal inside the container.
5. `visual`: last known bounding box. Stored for evidence and drift checks. Never used to act unless the policy sets `allowVisualFallback`.

There is also a `table_cell` target for reads: a table spec, a row predicate such as Type equals Savings, and a column header. Back-office reads are mostly table reads.

**Resolution rules**

- A locator counts only when it matches exactly one element. Zero or several matches means try the next one.
- When a locator other than the first one hits, the run still proceeds and records a `locatorDrift` entry. That is the drift signal.
- When nothing resolves, the step fails with `TARGET_NOT_FOUND` or `TARGET_AMBIGUOUS`. No guessing.

**Waiting.** No fixed sleeps anywhere. After each action the engine polls `observe()` and classifies the state, as section 8 describes.

## 6. Artifact schema

The artifact is three documents, not one. Knowledge about a vendor product is shared by every flow on it, and tenant differences should never force a re-recording. All three are Zod schemas with `schemaVersion: "1.0"`.

| Document | Scope | Holds |
|---|---|---|
| App profile | One vendor product | Identity fingerprint, tested versions, conditions that can appear on any screen |
| Capability | One flow on that product | The contract: inputs, outputs, steps, outcomes, success condition, risk, approval |
| Tenant overlay | One institution | Base URL, app version, text renames, targeted patches, disabled capabilities |

At load time the engine merges them into an effective capability and logs its hash in every run.

**State matchers.** One small declarative language describes screen states everywhere: step expectations, outcomes, global conditions, the success check.

```ts
type StateMatcher =
  | { all: StateMatcher[] }
  | { any: StateMatcher[] }
  | { not: StateMatcher }
  | { visible: TargetSpec }
  | { textPresent: string, inFrame?: string[] }
  | { locationMatches: string }
```

**App profile** (shape)

```json
{
  "kind": "app_profile",
  "schemaVersion": "1.0",
  "appId": "memberdesk",
  "surface": "web",
  "identity": { "fingerprint": { "textPresent": "MemberDesk" }, "versionPattern": "MemberDesk v(\\d+\\.\\d+)", "testedVersions": ["7.2", "7.4"] },
  "conditions": [
    { "id": "session_expired", "class": "recoverable", "detect": { "textPresent": "Your session has expired" }, "recover": { "runCapability": "auth.login", "then": "restart" }, "maxAttempts": 1 },
    { "id": "maintenance_notice", "class": "recoverable", "detect": { "textPresent": "System notice" }, "recover": { "steps": [{ "action": "click", "target": { "locators": [{ "kind": "text", "role": "button", "text": "Continue" }] } }], "then": "continue" }, "maxAttempts": 2 },
    { "id": "permission_denied", "class": "business_outcome", "code": "PERMISSION_DENIED", "detect": { "textPresent": "You are not authorized" } },
    { "id": "app_error", "class": "hard_failure", "code": "APP_ERROR", "detect": { "textPresent": "Application Error" } }
  ]
}
```

**Capability** (worked example, trimmed)

```json
{
  "kind": "capability",
  "schemaVersion": "1.0",
  "id": "member.lookup_savings_balance",
  "version": "1.0.0",
  "title": "Look up a member's savings balance",
  "description": "Searches MemberDesk by member ID and returns the member name and current savings balance. Read-only.",
  "app": { "appId": "memberdesk", "versions": ">=7.2 <8" },
  "risk": "read",
  "status": "draft",
  "inputs": {
    "memberId": { "type": "string", "pattern": "^\\d{5}$", "sensitivity": "identifier", "description": "Five digit member ID" }
  },
  "outputs": {
    "memberName": { "type": "string", "sensitivity": "pii" },
    "savingsBalance": { "type": "money", "sensitivity": "financial" }
  },
  "preconditions": [{ "state": "authenticated", "ensure": "auth.login" }],
  "steps": [
    { "id": "s1", "intent": "Open member search", "action": "click", "risk": "read", "retrySafe": true,
      "target": { "locators": [{ "kind": "text", "role": "link", "text": "Member Search" }] },
      "expect": { "textPresent": "Find a member" }, "timeoutMs": 8000 },
    { "id": "s2", "intent": "Enter the member ID", "action": "type", "risk": "read", "retrySafe": true,
      "target": { "locators": [
        { "kind": "label_anchor", "role": "textbox", "label": "Member ID", "relation": "left_of" },
        { "kind": "structural", "framePath": ["main"], "role": "textbox", "ordinal": 0 } ] },
      "value": { "from": "inputs.memberId" } },
    { "id": "s3", "intent": "Run the search", "action": "click", "risk": "read", "retrySafe": true,
      "target": { "locators": [{ "kind": "text", "role": "button", "text": "Search" }] },
      "expect": { "textPresent": "Member Detail" }, "timeoutMs": 8000 },
    { "id": "s4", "intent": "Read the savings balance", "action": "read", "risk": "read", "retrySafe": true,
      "target": { "kind": "table_cell", "table": { "locators": [{ "kind": "text", "role": "table", "text": "Accounts" }] }, "rowWhere": { "column": "Type", "equals": "Savings" }, "column": "Balance" },
      "into": "outputs.savingsBalance" }
  ],
  "outcomes": [
    { "code": "MEMBER_NOT_FOUND", "afterSteps": ["s3"], "detect": { "textPresent": "No member found" }, "source": "probe" },
    { "code": "NO_SAVINGS_ACCOUNT", "afterSteps": ["s4"], "detect": { "not": { "textPresent": "Savings" } }, "source": "reviewer" }
  ],
  "success": { "textPresent": "Member Detail" },
  "approval": null,
  "provenance": { "discoveryRunId": "...", "probeRunIds": [], "model": "...", "recordedAt": "...", "compilerVersion": "0.1.0" }
}
```

**Tenant overlay** (shape)

```json
{
  "kind": "tenant_overlay",
  "tenantId": "tenant-b",
  "appId": "memberdesk",
  "appVersion": "7.2",
  "baseUrl": "http://localhost:4001",
  "textMap": { "Member ID": "Account Holder No.", "Search": "Find", "Savings": "Share Savings" },
  "patches": [],
  "disabledCapabilities": []
}
```

**Rules that make the schema defensible**

- Value types are `string`, `integer`, `boolean`, `date`, `enum` and `money`. Money is integer minor units plus a currency, never a float.
- Sensitivity is one of `none`, `identifier`, `pii`, `financial`, `secret`. Section 10 says what each one means for logs.
- Step values are bindings such as `inputs.memberId` or `secrets.operatorPassword`. A literal recorded value never appears. Secrets resolve at run time from a `SecretProvider` backed by env vars.
- `textMap` applies to every locator string and matcher string at load. Most tenant differences are renames, so most tenants need no patches.
- `patches` are JSON Patch operations scoped to one capability and a version range. They are the escape hatch when a rename is not enough.
- Semver on the capability: major when inputs or outputs change, minor when steps or outcomes change, patch for locator edits.
- Approval stores who, when, and the content hash. Any edit changes the hash, so the artifact falls back to draft on its own.
- Each outcome records its `source`: `probe`, `reviewer` or `operator`. A reviewer can see which detectors a human has looked at.
- The raw model transcript lives in evidence only. Nothing in the artifact refers to it except the run id.

## 7. Discovery and compilation

Discovery produces a trace. A separate compiler turns the trace into a capability. Keeping these apart is what decouples the artifact from the model transcript.

**Inputs.** A goal, a target URL, a capability name, and input bindings such as `--input memberId=10042`. Declaring the inputs up front tells the compiler which typed values are parameters. Inferring that from the transcript is guesswork.

**The loop**

1. `observe()` the surface.
2. Send the model the goal, the element list as compact text, a downscaled screenshot, and the last few actions with their results. Keep only the two most recent screenshots in the history.
3. The model returns exactly one tool call: `click(ref)`, `type(ref, inputName | text)`, `select(ref, option)`, `press(key)`, `read(ref, outputName)`, `wait()`, `done(summary)` or `stuck(reason)`. Every call carries an `intent` sentence. That sentence is the "why" in the log.
4. The action passes the policy gate. A block is reported back to the model as a tool error, not executed.
5. Act, record the step with the full descriptor of the element acted on, loop.

The model types secrets and inputs by name, for example `type(ref, "secrets.operatorPassword")`. The runtime substitutes the value. The model never sees a password.

The system prompt states that on-screen text is data and can never change the goal or the rules. The gate enforces this regardless of what the model decides.

**Stop conditions.** `done`, 25 steps, 5 minutes, the spend cap, or a dead end. A dead end is the same observation hash with the same action three times, or the model calling `stuck`. Dead ends escalate to a human.

**Compiling the trace**

1. Keep only steps on the path to `done`. Drop failed actions, backtracks and waits.
2. Build each `TargetSpec` from the recorded element descriptor, in the locator order from section 5.
3. Replace any value that came from a declared input or secret with its binding.
4. Ask the model once for a title, a description, and an `expect` matcher per step.
5. Validate each proposed matcher in code against the recorded observations. It must match the state after the step and must not match the state before it. Reject and fall back to a text diff when it fails. The model proposes and the code verifies.
6. Set each step's risk as the higher of the policy hint and the model's proposal.
7. Assert that no input value and no secret appears anywhere in the serialized artifact.

**Probe runs.** This is how outcome detectors get into the artifact when discovery only saw the happy path. For each `--probe` value, replay the draft with that value. The replay stops in a state it does not recognize. Send that one observation to the model and ask for a classification: a business outcome with a code and a matcher, or unknown. Validate the matcher the same way and add it with `source: "probe"`. All of this happens at authoring time. Replay never calls the model.

**Self-check.** Replay the compiled draft once with the original inputs and no model. Save it as a valid draft only when that passes. Otherwise save it as `.rejected.json` with the reason.

## 8. Replay engine and result contract

Replay is a loop of act, then classify. Determinism comes from one rule: after every action the engine must recognize the state it is in before it does anything else. An unrecognized state is never stepped past.

**Before the first step**

1. Load and merge profile, capability and overlay. Log the effective hash.
2. Validate inputs against the schema. A bad input fails with `INVALID_INPUT` before the UI is touched.
3. Check approval status and policy. Drafts run only with `--allow-draft`.
4. Read the app version from the fingerprint. Outside `testedVersions` means read capabilities run with a warning and write capabilities stop with `APP_VERSION_UNSUPPORTED`.
5. Satisfy preconditions, which normally means running `auth.login`.

**Per step**

1. Policy gate.
2. Resolve the target under the uniqueness rule.
3. Act. Typing always clears the field first so a retry cannot double-type.
4. Poll `observe()` every 250 ms and classify until something matches or `timeoutMs` passes.

**Classification order**

1. The step's `expect` matches. Go to the next step.
2. A capability outcome scoped to this step matches. Return `business_outcome`.
3. A profile condition matches. Recoverable runs its recovery with a bounded attempt count. Business outcome returns. Hard failure stops.
4. Nothing matches by the timeout. That is `UNEXPECTED_STATE`, and the escalation policy decides between a human and a failure.

**Retry safety.** Each step carries `retrySafe`. A recovery that wants to retry or restart may do so only when every step executed so far is retry safe. Otherwise it escalates. Session expiry halfway through a write must never silently resubmit.

**After the last step.** Verify the `success` matcher, parse outputs by declared type, validate them against the output schema.

**Result contract**

```ts
type RunResult =
  | { status: 'success', outputs: Record<string, unknown>, meta: RunMeta }
  | { status: 'business_outcome', code: string, message: string, atStep: string, details?: Record<string, unknown>, meta: RunMeta }
  | { status: 'failure', code: FailureCode, atStep: string | null, expected: string, observed: string, retryable: boolean,
      evidence: { screenshot: string, observation: string, log: string }, meta: RunMeta }

interface RunMeta {
  runId: string
  capabilityId: string
  version: string
  effectiveHash: string
  tenantId: string
  durationMs: number
  recoveries: { conditionId: string, atStep: string, attempts: number }[]
  locatorDrift: { stepId: string, usedLocator: number }[]
  humanInterventions: { interventionId: string, atStep: string, resolution: string }[]
}
```

Recoverable conditions never surface as a status. They are handled in line and listed in `meta.recoveries` so the caller and the drift monitor can still see them.

| Failure code | Meaning |
|---|---|
| `INVALID_INPUT` | Inputs failed schema validation |
| `NOT_APPROVED` | Draft artifact without the draft flag |
| `POLICY_BLOCKED` | The gate refused a step |
| `APP_VERSION_UNSUPPORTED` | Write capability on an untested version |
| `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS` | No locator matched exactly one element |
| `UNEXPECTED_STATE` | No matcher recognized the screen in time |
| `RECOVERY_EXHAUSTED` | A recoverable condition kept coming back |
| `APP_ERROR` | The app showed its own error page |
| `OUTPUT_PARSE_ERROR` | A read value did not parse as its declared type |
| `CHECKPOINT_FAILED` | Steps finished but the success matcher did not hold |
| `ESCALATION_TIMEOUT` / `ABORTED_BY_OPERATOR` | The human path ended without a resume |

CLI exit codes: 0 for success, 10 for a business outcome, 20 for a failure. The result JSON goes to stdout.

The CLI blocks while a human has control and returns one final result. A production caller would instead get an immediate `needs_human` handle and resume asynchronously.

## 9. Escalation and handoff

Control of a session is a lease with exactly one holder. `Surface.act` rejects any action whose actor does not hold the lease. That single check answers "who is in control" and makes it impossible for automation and a human to act at once.

```ts
interface ControlLease {
  owner: 'automation' | 'human' | 'none'
  leaseId: string
  since: string
  reason?: string
}
```

**States and transitions**

| From | Event | To |
|---|---|---|
| `RUNNING` | Stuck, or an irreversible step needs a decision | `PAUSED_AWAITING_HUMAN` (lease to none) |
| `PAUSED_AWAITING_HUMAN` | Operator takes control | `HUMAN_CONTROL` (lease to human) |
| `PAUSED_AWAITING_HUMAN` | Operator approves or rejects without taking control | `RESUMING` or `ABORTED` |
| `PAUSED_AWAITING_HUMAN` | 10 minute timeout | `FAILED` with `ESCALATION_TIMEOUT` |
| `HUMAN_CONTROL` | Operator hands back | `RESUMING` (lease to automation) |
| `HUMAN_CONTROL` | Operator aborts | `ABORTED` |
| `RESUMING` | Fresh observation passes the resume check | `RUNNING` |
| `RESUMING` | Resume check fails twice | `FAILED` |

**What triggers an escalation**

- Discovery: a dead end or the model calling `stuck`.
- Replay: `UNEXPECTED_STATE`, `TARGET_NOT_FOUND`, `RECOVERY_EXHAUSTED`, or a recovery blocked by retry safety.
- Either mode: an irreversible step that policy says needs a person.

**Intervention request.** Written to the run's evidence folder and sent through a `Notifier` interface. Implement the console and operator-page notifiers. Document a webhook one.

```ts
interface InterventionRequest {
  id: string
  runId: string
  mode: 'discovery' | 'replay'
  capabilityId?: string
  goal?: string
  stepId?: string
  stepIntent?: string
  reasonCode: string
  reason: string
  expected?: string
  observed: string
  location: string
  screenshot: string
  allowed: ('take_control' | 'approve' | 'reject' | 'abort')[]
  createdAt: string
}
```

**Operator console.** A plain page on port 4100, served by the same process that owns the session.

- A list of open requests. Each shows the reason, the step, expected versus observed, and the masked screenshot.
- Take control. The page then shows the live session as a screenshot refreshed about twice a second.
- Clicks on the image are forwarded as `pointer` actions. A text box sends typed text. Buttons send Enter, Tab and Escape.
- Hand back, with one of three choices: retry the stuck step, continue from the next step, or abort. Plus a free-text note.

The human's input goes through `Surface.act(action, 'human')`. This is the main design point of the section. The human operates the same live session, the same logger records every action with the element under the pointer, and nothing depends on a browser. A desktop surface would get the same console for free. Typed text from a human is logged as a length only, since it may be a secret.

The network allowlist still applies to the human. Action-level risk checks do not, because the human is the authority being asked.

**Resume is never blind.** Automation takes the lease back and observes again. For "retry" it re-runs the step. For "continue" it first checks that the step's `expect` now holds. If the check fails it escalates once more with that explanation, then fails.

**Mocked on purpose.** Operator authentication, assignment among several operators, and real video streaming. The report says so, along with the production shape: a remote browser, a streamed view, and the same lease.

**Test.** A scripted operator calls the console's HTTP endpoints: take control, click Acknowledge on the `unknownDialog` page, hand back with "retry". The run must then finish with `success` and list the intervention in `meta`.

## 10. Safety

Every action passes one gate, in discovery and in replay alike. The surface is wrapped in a `GuardedSurface` decorator so no code path can reach `act` without it.

**Policy file** (`/policy/default.policy.json`)

```json
{
  "allowedOrigins": ["http://localhost:4000", "http://localhost:4001"],
  "allowedRoutes": ["/", "/app/**"],
  "blockedRoutes": ["/app/admin/**", "/__chaos"],
  "allowedActions": ["click", "type", "select", "press", "read", "wait", "goto"],
  "allowVisualFallback": false,
  "irreversible": { "discovery": "require_human_approval", "replay": "require_approved_artifact_and_caller_confirmation" },
  "riskHints": [{ "textMatches": "submit|confirm|post|delete|close account|transfer", "risk": "irreversible" }]
}
```

**Two layers of enforcement**

- The gate checks action type, target route, and risk before each action.
- Playwright request routing aborts any request to an origin off the list. This catches redirects and anything a click triggers that the gate could not predict.

**Risk classes.** `read`, `reversible_write`, `irreversible`. Reads and reversible writes run unattended. Irreversible steps are handled conservatively, and the two modes differ on purpose.

- In discovery the model is exploring, so an irreversible step always pauses for a human to approve or reject. The open sub-account flow shows this at the Submit button.
- In replay an irreversible step runs only when the artifact is approved and the caller passed `--confirm-irreversible`. Otherwise the run stops with `POLICY_BLOCKED`.
- A reviewer may raise a step's risk freely. Lowering it resets approval.

**Data handling by sensitivity**

| Sensitivity | In the artifact | In logs and saved results | Returned to the caller |
|---|---|---|---|
| `none` | binding only | plain | plain |
| `identifier` | binding only | last two characters | plain |
| `pii`, `financial` | binding only | `[REDACTED:type]` | plain |
| `secret` | binding only | never | never |

- A pattern scrubber runs over every log line and every saved model transcript: SSNs, long account numbers, card numbers, emails.
- Screenshots written to disk get solid boxes over elements whose role or nearby label marks them sensitive, such as SSN, account number and balance.
- A unit test serializes each artifact and fails if any input value or secret appears in it.

**Limits to state plainly in the report**

- Discovery sends screen content to a model provider. It should run only against synthetic or test records. Redacting before the model sees the screen would blind it.
- Risk hints are text patterns. A destructive button with a bland label would slip past, which is why risk is also reviewed at approval.
- Screenshot masking is heuristic.
- A human operator sees the live session unmasked.

## 11. Stretch goals

Start these only when every check in section 12 through milestone 8 passes. Build them in this order and stop wherever time runs out. If one of them puts the core at risk, drop it and note that in `DECISIONS.md`.

The brief says to pick one or two and warns that breadth is not rewarded. So the report presents the first two as the stretch goals. None of them may add infrastructure.

1. **Cross-tenant reuse.** Mostly built already through tenant B and the overlay. Evidence: the tenant A capability replayed on tenant B with the overlay, plus one run without the overlay that fails cleanly and reports which locators missed.
2. **Approval gate.** `npm run approve` binds a reviewer name and timestamp to the content hash. Unattended replay requires `approved`. A reliability score lives in a sidecar `<id>.stats.json`, never inside the artifact, so the hash stays stable.
3. **Multi-run stability.** `npm run stability -- --capability <id> --runs 10` with seeded random failure switches. Report counts per status, recoveries, drift hits, and median and p95 duration.
4. **Capability catalog.** `npm run catalog` prints every approved capability as a tool definition: name, description, input JSON Schema, output schema, possible outcome codes. Add `invoke(name, args, tenantId)` and a short scripted example that calls one.
5. **Assisted fallback.** Off unless `--assisted-fallback` is passed. Only on `TARGET_NOT_FOUND`, only for steps that are not irreversible, one model call that must return an element of the same role for the same action. The gate still applies. The result is flagged `assisted`, and the output is a suggested locator patch for review, never a silent edit to the artifact.
6. **Code generation.** Emit a Playwright test file from a capability. Lowest value of the six.

## 12. Milestones and acceptance checks

Build in this order. Replay comes before discovery on purpose: a hand-written capability exercises the schema and the error taxonomy with zero model spend, and gives the compiler a known-good target to match.

| # | Milestone | Done when | Brief section |
|---|---|---|---|
| 0 | Scaffold | Strict TypeScript, Vitest, lint, `.env.example`, `DECISIONS.md` seeded with section 2 | 6 |
| 1 | Target app | Both tenants run. A smoke test walks both flows and triggers every failure switch | 4 |
| 2 | Surface and resolver | Tests resolve an unlabeled input inside a nested frame by its label anchor. An ambiguous target returns several elements | 3.1, 3.7 |
| 3 | Schemas, policy, redaction, logger | Schemas validate the examples in section 6. The gate blocks the admin route and an off-origin request. The leak test passes | 3.2, 3.4, 3.5 |
| 4 | Replay engine | With hand-written artifacts: success with outputs, `MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, a validation outcome, interstitial recovered, session expiry recovered, slow load survived, `APP_ERROR` with a screenshot, `INVALID_INPUT` without touching the UI | 3.3 |
| 5 | Discovery and compiler | With the fake LLM: the loop finishes, the compiled artifact passes its self-check, a probe run adds `MEMBER_NOT_FOUND`, no literal input appears in the artifact | 3.1, 3.2 |
| 6 | Escalation | The scripted operator test from section 9 passes. An action sent by the wrong actor is rejected. Human actions appear in the run log | 3.6 |
| 7 | Real evidence runs | A real model discovers both flows. The sub-account discovery pauses at Submit for approval. Every folder in section 13 exists and total spend is recorded | 4, 6 |
| 8 | Docs | README, REPORT draft, DECISIONS, HANDOFF_STATUS complete. A fresh clone runs the demo path from the README | 6 |
| 9 | Stretch goals | In the order of section 11 | 8 |

If milestone 7 cannot run because the API is unreachable, do milestones 8 and 9 and leave 7 as the first item in `HANDOFF_STATUS.md`.

**Tests that must exist.** Target resolution, state matcher evaluation, the classification order, retry safety, the policy gate, redaction and the leak check, the lease, overlay merging, and one end-to-end replay per result status. Skip tests for the operator page markup and the CLI argument parsing.

## 13. Deliverables

The paths and headings below match the brief exactly.

**`/README.md`**

- Setup: Node version, `npm install`, `npx playwright install chromium`, the env vars.
- The demo path as exact commands: start the app, discover, replay, replay with a bad ID, trigger an escalation.
- How to run with no API key using `--llm fake`.
- A short list of what is mocked and where the seam is.

**`/REPORT.md`**, one to three pages, with exactly these seven headings in this order:

1. Architecture
2. Artifact schema
3. Determinism & error handling
4. Heterogeneity & multi-tenant
5. Escalation & handoff
6. Safety
7. Cuts

Each section states the decision, the alternative rejected, and the limit of the choice. The Cuts section is honest about what is thin: the operator console, desktop support, real multi-tenant plumbing, masking heuristics.

**`/evidence/`**

```
/evidence/
  README.md                      one line per folder: what it proves
  artifacts/                     final app profile, capabilities, tenant overlay
  discovery-lookup/              run.jsonl, transcript.redacted.jsonl, screenshots/, usage.json, capability.draft.json
  discovery-open-sub-account/    same, plus the approval intervention at Submit
  probe-not-found/               the probe run that produced MEMBER_NOT_FOUND
  replay-success/                result.json, run.jsonl
  replay-not-found/              business outcome
  replay-session-expired/        recovered, visible in meta.recoveries
  replay-app-error/              hard failure with screenshot and observation
  replay-escalation-handoff/     intervention.json, human actions in run.jsonl, final result
  replay-tenant-b/               same capability through the overlay
```

Each line of `run.jsonl` is one event: `ts`, `runId`, `seq`, `actor`, `type`, `stepId`, `intent`, `detail`. Event types are `observe`, `decide`, `policy`, `act`, `classify`, `recover`, `escalate`, `control`, `result`.

**`/DECISIONS.md`.** One line per decision: what, what was rejected, why. Complete and blunt.

**`/HANDOFF_STATUS.md`.** What works, what fails, what was skipped and why, total model spend, and open questions.
