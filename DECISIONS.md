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
