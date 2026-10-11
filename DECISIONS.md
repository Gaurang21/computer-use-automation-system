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
