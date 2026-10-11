# Decisions

One line per decision: the choice, what was rejected, and why.

## Locked at the start (plan section 2)

- **Language:** TypeScript in strict mode on Node 22+. Rejected Python. TypeScript and Playwright are my daily tools and I have to defend every line.
- **UI driver:** Playwright with Chromium. Rejected Selenium and Puppeteer. Weaker frame handling and waiting.
- **Schemas:** Zod, with JSON Schema exported from it. Rejected hand-written interfaces. No runtime validation and no schema a calling agent can read.
- **Model:** Anthropic API, model id from `CUA_MODEL` (default `claude-sonnet-5-5`). Rejected a hosted agent SDK. It hides the loop the graders want to see.
- **Model tooling:** Our own tool definitions that act on numbered elements. Rejected the provider's built-in computer-use tool. It ties us to one vendor and to pixel coordinates.
- **Perception:** Accessibility tree plus a screenshot. Rejected raw DOM selectors (they do not exist on desktop) and pure pixels (no stable replay targeting).
- **Target:** A local mock back-office app built to be hostile. Rejected a public demo site. No control over failure modes, and terms-of-use risk.
- **Architecture:** One Node process, a CLI, JSON files on disk. Rejected services and queues. The brief penalizes premature infrastructure.
- **Operator surface:** A local web console that drives the same session through the same Surface interface. Rejected a headed browser the human clicks in directly. It fails headless, fails for remote sessions, and needs DOM hooks to record the human.
- **Tests:** Vitest. Rejected Jest. Slower setup for TypeScript.
- **Artifacts hold no CSS or XPath.** Targets are role, name, nearby label and structure. A selector is a web-only idea and a desktop accessibility API can answer all of these.

## Made during the build

- **TypeScript 6.0.3, not 7.0.** 7.0 (the native compiler) is out, but typescript-eslint 8.x only supports TypeScript below 6.1. 6.0 is the newest stable version the whole toolchain supports.
- **Node 22 minimum.** Vitest 5 requires Node 22.12 or newer. Pinned in `.nvmrc` and `engines`.
- **`tsx` runs TypeScript directly, no build step.** Rejected compiling to `dist/`. Nothing here ships as a package, so a build step adds a moving part with no payoff.
- **Runtime dependencies are added in the milestone that first needs them.** Keeps each commit reviewable on its own.
- **Commit straight to `main` in small commits.** No feature branches. Each commit is small enough that `git bisect` points at the cause when something breaks.
- **Demo member IDs come from the seed (10001-10008).** The plan's examples used 10042, which is outside the seed range. 10001 is the happy path, 99999 is not found, 10004 has no savings, 10006 is restricted.
- **Chaos fires only on signed-in `/app` pages, never on the banner, nav or sign-on.** Faults always land in the frame the automation is working in, which keeps the failure tests deterministic.
- **Dismissing an interstitial replays the interrupted request** (same method, URL and form fields). That is how real maintenance notices behave, and it lets recovery mean "click Continue" with no extra state.
- **One Express app per tenant, built from a config object.** Rejected two codebases. Tenant B differs only in labels, nav order, branding and version, which is exactly the "same vendor product" case the brief describes.
- **Perception via CDP `Accessibility.getFullAXTree` per frame.** Rejected Playwright's aria snapshot. The snapshot flattens nested layout tables into huge merged rows and gives no node handles. The CDP tree handles the frameset cleanly, drops layout tables on its own, and every node carries a backend id to act on.
- **Actions use real input on the element's on-screen box** (`DOM.getContentQuads` then the mouse; focus then the keyboard). Rejected building selectors or calling `element.click()` in page JS. Real input behaves like an operator and maps one to one onto desktop `SendInput`.
- **`select` sets the option through the node, by visible label.** Rejected clicking through the native dropdown, which is unreliable headless. The desktop equivalent is UIA `SelectionItemPattern`.
- **Raw `pointer` and `key` actions are human only.** Automation must act on resolved elements so every automated step stays replayable and policy-checkable.
- **The resolver is a pure function over the observed element list.** Rejected putting matching inside the browser. A pure resolver is unit-testable without a browser and is reused as is by the desktop surface.
- **Tables get a `label_anchor` too.** The Accounts table has no accessible name, so it is found by the text above it, the same rule as unlabeled inputs.
- **The observation hash ignores geometry.** It covers frame URLs plus every element's role, name and value, so a re-render with identical content counts as the same screen (dead-end detection) while any content change does not.
- **Chromium executable:** Playwright's bundled browser when installed, else `CHROMIUM_PATH`, else `/opt/pw-browsers/chromium`. The cloud sandbox ships an older Chromium build than Playwright 1.64 expects, and all tests pass on it.
- **Hand-written flow capabilities live in `tests/fixtures`, not `/capabilities`.** `/capabilities` holds only what discovery produces, plus the parts no discovery run would produce: the app profile, `auth.login` and the tenant overlays. The replay engine is built and tested against the fixtures first.
- **`textMap` renames whole strings only.** Rejected substring replacement, which would turn "Member Search" into "Member Find" when "Search" maps to "Find".
- **Credentials are mapped per tenant in the overlay** (`secrets.operatorPassword -> env MEMBERDESK_OPERATOR_PASSWORD`). Each institution has its own credentials, so the capability holds a binding and the overlay says where that tenant's value comes from.
- **Capabilities declare an `entry` (path plus ready matcher) and named preconditions.** Every replay starts from a known screen, and `auth.login` is just another capability.
- **Value bindings are `inputs.*`, `secrets.*` or `const`.** `const` exists for fixed, non-sensitive values such as a key name. The leak test guards that no demo input appears anywhere in an artifact.
- **The network layer enforces the route blocklist, not just origins.** Clicking the Administration link is aborted at the network even though the click itself looked harmless.
- **Risk hints only raise risk.** The gate takes the higher of the declared risk and the hint, so an under-declared Submit is still treated as irreversible.
- **Logs never contain a full observation.** `run.jsonl` holds intents, target descriptors, decisions and redacted values. Full element lists are saved as separate scrubbed files only on failure or at checkpoints.
- **Known-value redaction plus pattern scrubbing.** Patterns alone cannot recognise a member's name, and known values alone miss data nobody registered, so both run on every write.
- **Generated JSON Schemas are committed under `/schemas`, with a test that fails when they go stale.** A calling agent reads the contract there without reading TypeScript.
- **`pngjs` for screenshot masking.** Rejected Playwright's `mask` option, which needs selectors, and `sharp`, which is a native dependency.
- **After any click, key press or goto, replay waits for the screen to change (observation hash, capped at 1.5 s).** Without it, the next classification could see the stale page. A real case: the maintenance notice is still on screen just after its Continue was clicked, which counts as a second occurrence. Rejected waiting on browser navigation events, which are web-only. The hash check works on any surface.
- **Outcomes scoped to a step are also checked when that step's target is missing.** "No savings account" shows up as a missing table row, not as a new screen, so the classifier runs before TARGET_NOT_FOUND is declared.
- **TARGET_AMBIGUOUS fails at once instead of waiting out the timeout.** Two savings rows will not become one by waiting.
- **Recoveries that re-run work (`retry_step`, `restart`) check retry safety. `continue` recoveries do not.** Dismissing an interstitial replays the request it interrupted, which was never processed, so it cannot duplicate a write.
- **A read step registers the value it reads for redaction before the action is logged.** A test caught the member's name leaking into `run.jsonl` through the logged element description.
- **The approve command is part of the core, not deferred to stretch.** The irreversible-step policy depends on approval, so the open sub-account replay could never reach Submit without it.
- **Precondition and recovery sub-flows prefix their step ids (`auth.login:s3`).** A failure inside the login says so, instead of claiming step s3 of the main flow.
- **Discovery takes a goal spec file (`goals/*.json`), not a pile of CLI flags.** The spec declares typed inputs with demo values, typed outputs, probes, limits, and the fake script. It is reviewable, repeatable, and keeps input types out of guesswork. Rejected the plan's `--goal/--input/--probe` flags, which cannot carry types or sensitivity.
- **Preconditions are replayed, not discovered.** Discovery signs on with the deterministic `auth.login` before the model sees anything. The model spends no tokens on login and never handles credentials, even as bindings.
- **Each model decision is one stateless request**: goal, declared inputs and outputs, the last 8 actions, the current element list and one screenshot. Rejected a growing chat history. Cost stays linear in steps, only the latest screenshot is sent, and no history is ever edited (current models invalidate thinking on edited history).
- **`tool_choice: auto` with strict tools and one nudge.** Forced tool choice returns a 400 on Sonnet 5.5. `strict: true` guarantees valid arguments, the prompt asks for exactly one call, and a reply with no tool call gets one reminder before it counts as `stuck`.
- **Server-side refusal fallback is on (`fallbacks: "default"`).** A declined request is re-run on Anthropic's recommended fallback model instead of failing the run. Spend is priced at the more expensive of the requested and serving models.
- **The API base URL is pinned to `https://api.anthropic.com`** (override with `CUA_ANTHROPIC_BASE_URL`). Coding-agent sandboxes set `ANTHROPIC_BASE_URL` for their own use, and the SDK would silently follow it.
- **Effort `medium` for every model call.** Clicking through a form is not hard reasoning. Kept within the $5 project budget, and per call well under the $1 run cap.
- **A model that types an input's raw value still gets a binding.** The agent maps a literal equal to a declared input onto `inputs.x`, so a sloppy model cannot bake a member ID into the artifact. The compiler's leak check is the backstop.
- **For read steps the compiler never locates the element by its own text.** That text is the value being read ("Avery Lindqvist"). Reads use the nearby label or the table row and column.
- **The compiler keeps only locators that pick out exactly the recorded element on the recorded screen.** An unverified locator would only become a TARGET_AMBIGUOUS at replay time.
- **Model-proposed expectations are verified, and a text diff is the fallback.** The proposal must hold after the step and not before it. Otherwise the compiler takes the first stable, digit-free text that is new on screen.
- **Probe runs reuse the replay engine's escalation seam.** A capturing "escalation" records the unrecognised screen and aborts, then the model classifies that one screen. The proposed matcher must match the probe screen and not the happy-path screen.
- **A self-check that stops at the irreversible step with POLICY_BLOCKED still counts as a pass.** An unapproved draft can never replay past Submit, by design.
- **The lease check lives in `GuardedSurface.act`, ahead of the policy gate.** One check answers "who is in control", for automation and humans alike. While a run is paused nobody holds the lease, so neither side can act until an operator explicitly takes control.
- **One control state machine per live session, not per intervention.** A failed resume check moves the same session back to PAUSED, and a second failure moves it to FAILED. The state and the lease owner are derived from each other, so they can never disagree.
- **The operator hub runs in the process that owns the browser.** The human's clicks are `Surface.act(action, 'human')` on the same session, recorded by the same logger with the element under the pointer. Rejected a separate operator service, which would need a remote-browser protocol for a demo that has one operator.
- **The live view is unmasked and the saved screenshots are masked.** The operator is the person being asked to act on the record. Anything written to disk follows the redaction rules.
- **Typed text from a human is logged as its length only.** It may be a password.
- **Probe replays and real escalations share one interface (`Escalation.request`).** A probe is just an escalation that captures the screen and aborts.
- **On "continue", the engine re-checks the step's expectation.** If the screen still does not match, it escalates once more with that explanation, then fails. Rejected trusting the human's word, because a handback is a claim about state and claims get verified.
- **Discovery approvals are their own request kind (`approval`).** They offer approve and reject, not take control: the question is "may this irreversible click happen", not "fix the screen".
- **The CLI blocks while a human has control.** A production caller would get an immediate `needs_human` handle and resume asynchronously. That is a transport choice, and the hub and state machine stay the same.
- **No `npm run operator` standalone command.** The console only means something next to a live session, so it starts automatically with `replay` and `discover` (`--no-operator` turns it off).
- **Enum input values are exempt from the leak check.** "Money Market" is one of the allowed options in the input contract, not leaked data.
