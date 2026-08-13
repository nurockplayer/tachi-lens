# tachi-lens

Twitch chat immersive translation Chrome Extension. Manifest V3, BYOK, supporting Gemini, DeepSeek, OpenAI, Claude.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install local dependencies; CI uses `pnpm install --frozen-lockfile` |
| `pnpm dev` | Vite watch build, outputs to the ignored `dist/` |
| `pnpm test` | Run the full Vitest suite |
| `pnpm test:e2e` | Run full Playwright E2E (builds first) |
| `pnpm test:full` | Run full unit + E2E regression |
| `pnpm typecheck` | TypeScript strict type check |
| `pnpm build` | Production Vite build, popup CSP check |
| `pnpm classify:risk` | Print the validation tier for the current change |

## Architecture

```text
src/background/  Service Worker: API keys, provider calls, batch/cache/rate limiting, message routing
src/content/     Twitch DOM observer, filter, translation queue, non-destructive DOM injection
src/popup/       React settings and diagnostics UI
src/providers/   Provider adapters, registry, prompt contract
src/storage/     chrome.storage wrapper and settings schema
src/shared/      SW/Content/Popup shared message protocol and i18n
```

Data flow: the Content Script only sends `{messageId, text, priority?}` to the Service Worker; the Service Worker reads settings and the full API key, performs translation, and returns the result; the Popup manages non-sensitive settings through a trusted storage wrapper and manages the API key, key preview, and diagnostics through runtime messages.

## Runtime and security invariants

- The full API key is read only by the Service Worker and stored only in `chrome.storage.local`; the Content Script and Popup must never obtain the full key directly.
- The Content Script does not read storage directly; all cross-context data goes through the runtime protocol and type guards in `src/shared/messages.ts`.
- The translation UI preserves the original Twitch text and does not replace the message body.
- Twitch selectors are centralized in `src/content/twitch-selectors.ts`; fallback collection must merge and deduplicate, never taking only the first DOM variant.
- Extension context invalidation is a terminal lifecycle; ordinary provider/network errors follow the existing retry/processed contract.
- Diagnostics must not contain original chat text, usernames, or API keys.

## Development rules

- Use pnpm; keep `pnpm-lock.yaml` and never add another lockfile or a package-manager lifecycle enforcement script.
- Keep TypeScript strict; colocate tests with source, and add a failing regression test before a bug fix.
- Use React only in the Popup; keep the Content Script as plain TypeScript/DOM.
- Before designing or redesigning a frontend page, use `design-taste-frontend`; for dense product UI such as the Popup, prioritize the existing design system and task ergonomics.
- Do not commit `dist/`, `.omc` session/state noise, release zips, or other generated artifacts.

## Validation tiers

Validation is risk-based, deterministic, and path-based; there is no LLM-based test selection. `scripts/classify-risk.mjs` classifies a change by the files it touches relative to `origin/main`.

| Tier | When | Validation |
| --- | --- | --- |
| T0 Focused | Inner loop only (not CI) | `pnpm vitest run <path>` on affected tests |
| T1 Docs | Every changed file is markdown (`*.md`) or under `docs/` | `check` only; Playwright E2E is skipped |
| T2 Runtime | Any other changed file (source, manifest, dependencies, e2e specs, scripts, build config, locales, workflows) | `check` + full Playwright E2E |

- `check` always runs (agent-docs sync, lint, typecheck, full Vitest, build); full Vitest is cheap and is never skipped.
- Playwright E2E is gated on the classifier: it runs only for runtime changes (T2) and is skipped for docs-only changes (T1).
- Fail-safe escalation: an unknown, ambiguous, empty, or unparseable change set escalates to T2 (full E2E). Only an explicit `*.md`/`docs/` match skips E2E.
- Inner loop: prefer focused affected tests (`pnpm vitest run <path>`) over repeated full `pnpm test`.
- Full regression (all unit + E2E) is available anytime via `pnpm test:full`.
- The live Twitch canary remains a separate scheduled workflow and is never a routine PR gate.

## Language policy

English is the canonical language for technical artifacts. Code, identifiers, comments, docstrings, tests, logs, developer-facing errors, branches, commits, technical plans, implementation details, architecture, API/schema documentation, CI/CD documentation, and review findings must be written in English. Concise Japanese summaries are allowed for team-facing issues/PRs when useful, but detailed technical specifications must remain in English. User-facing copy, localization resources, language-sensitive fixtures, and test data where language is product behavior are preserved in their original languages and are not part of this policy.

## Maintenance policy

- Prefer the smallest production-safe fix over architectural completeness.
- Work is justified only when it: (a) breaks core translation behavior, (b) causes recurring API/operational cost, or (c) creates severe reliability, performance, or user-abandonment risk.
- Do not refactor unrelated code, add speculative abstractions, or clean up for aesthetics alone.
- Add only the minimum regression coverage needed to prove the fix.
- Preserve working behavior outside the explicit acceptance criteria.
- Record non-blocking cleanup, UI polish, architecture improvements, and broader edge cases as deferred technical debt.
- Stop once acceptance criteria and validation pass.
- Use `arbiter` only for clearly scoped, high-difficulty decisions the default model cannot resolve reliably.

## Scope and Git policy

- A GitHub Issue is the implementation source of truth; each PR focuses on one clear problem, and additional requirements open a separate issue/PR.
- `docs/` research, notes, and plans provide only background; unless an issue explicitly references them, they are not an implementation source of truth.
- The project uses `main` as the PR base; do not apply other projects' develop/release branch models.
- Use `rtk git ...` / `rtk gh ...` for all git/gh shell commands; do not prefix pnpm, tests, or ordinary shell commands with `rtk`.
- Public state changes such as push, PR, issue comment, label, and merge require explicit user authorization.
- Technical issues and important trade-offs belong in the relevant Issue or PR, not only in chat history.

## Spec and implementation routing

Implementation follows a Selective Lightweight SDD policy: the Issue remains the unit of execution, and a lightweight spec is introduced only when multiple independent implementations could diverge on a shared contract, or when high-impact correctness semantics such as migration/compatibility/rollout/privacy/security/concurrency/release-transaction need to be frozen before implementation.

### Issues remain the unit of execution

- Each implementation PR closes one focused GitHub Issue; ordinary isolated bugs, maintenance, dependency, CI, test, copy, and bounded features do not require a separate Spec.
- Do not introduce a requirements → design → tasks pipeline. Research-only work never needs a Spec first.

### Selective Spec gate

A lightweight Spec is required only when at least one of the following holds:

- (a) Multiple independent implementable Issues share the same behavior/API/schema/protocol/storage/model contract.
- (b) Parallel agents could implement incompatible interpretations.
- (c) High-impact correctness semantics such as migration/compatibility/rollout/privacy/security/concurrency/release-transaction need to be frozen before implementation.
- (d) A parent/initiative needs a durable contract consumed by several child Issues.

### Spec levels

- **Level 0 — Issue-only (`Spec: N/A`)**: the default for bounded independent work, with no Spec artifact.
- **Level 1 — Inline spec (`Spec: Inline — this issue`)**: the contract is frozen in the owner/parent Issue, without a repository Spec file.
- **Level 2 — Repository spec (`Spec: docs/specs/<name>.md`)**: a durable contract shared across multiple Issues or persisting across waves, stored only in `docs/specs/`.

Do not add new levels or introduce a heavyweight SDD framework.

### Responsibility split

- The Spec defines the **what** that must hold across implementation boundaries: observable behavior, shared contracts, invariants, failure semantics, compatibility boundaries, and non-goals.
- The Issue defines the atomic repository change: scope, AC, validation, dependency, and implementation boundary.
- The implementing agent owns the local implementation details.

### Source-of-truth precedence

`repository rules → referenced/current Spec → Issue scope + AC → existing implementation → agent assumptions`

An Issue can narrow the work required by a Spec, but must not silently change a shared Spec contract.

### Parallel implementation freeze

Once multiple Issues have been dispatched against the same shared Spec, the contract is frozen. If the contract is found to be wrong, incomplete, or in conflict with `main`, do not silently reinterpret or rewrite it; report **SPEC BLOCKER** (minimal-conflict decision), deliberately update the authoritative Spec/Issue, and identify the affected in-flight Issues.

### Parallelization is the success criterion

The Spec must improve independent implementation boundaries rather than increase approval latency. Multiple Issues referencing the same Spec must not serialize independent implementations; prefer a single frozen shared contract feeding parallelizable disjoint Issues.

### Issue metadata convention

The `## Specification` section supports:

- `Spec: N/A`
- `Spec: Inline — this issue`
- `Spec: docs/specs/<name>.md`

Legacy/closed Issues are not required to have this section; do not bulk-rewrite the backlog.

## Agent workflow

- See `docs/agents/issue-tracker.md` for Issue tracker operations; see `docs/agents/governance.md` for governance pattern decisions.
- Delegate broad scans, diff grouping, log summaries, and test drafts to a DeepSeek worker first; the controller must re-read referenced files and verify important claims.
- The controller is responsible for the actual edit, tests, security/architecture judgment, commit/push/PR, and the final user-facing conclusion.
- Workers/external models must not be responsible for destructive commands, public state changes, or final approval.
- GSD yolo mode only controls planning convenience and phase auto-advance; it must not authorize skipping issue scope, delivery gates, or public-state-change authorization; see `docs/agents/gsd-workflow.md`.

## Model routing

Implementation follows a three-layer cost-aware routing policy; optimize total completion cost and throughput rather than routing by ticket size alone.

1. **DeepSeek V4 Flash** — bounded, low-uncertainty implementation where location, implementation strategy, repository pattern, and acceptance criteria are already known. Flash gets one normal implementation attempt plus at most one obvious mechanical correction (lint/format/typo/clear type or assertion mismatch). Do not ask merely whether Flash can complete the work; default to the cheapest layer that can reliably finish.
2. **Intermediate reasoning controller (DeepSeek V4 Pro or Gemini-class)** — diagnosis, repository exploration, design narrowing, log analysis, and turning uncertainty into a concrete implementation contract. Escalate beyond Flash when root cause is unclear, assumptions are wrong, architecture must be re-explored, scope expands, contracts are unclear, a reviewer finds a conceptual error, or the same validation failure repeats.
3. **Sol** — only for the smallest unresolved architecture, concurrency, security, correctness, or API/data-contract decision after the intermediate layer has narrowed the problem. Do not start with Sol when a cheaper reasoning pass can narrow the problem. Ask Sol only for the smallest unresolved decision and require a concrete decision/implementation contract; return mechanical implementation and routine test fixes to Flash afterward.

On conceptual uncertainty, Flash escalates to the intermediate reasoning layer before Sol. Reuse already acquired repository context across related work instead of repeatedly paying for full-repo exploration.

## Automated review validation

This section specifies how the Controller determines whether an automated review on a PR (bots such as CodeRabbit, chatgpt-codex-connector) actually ran, so that bot notices that never performed a review are not mistaken for a valid review or a review finding.

### Repository reference

CodeRabbit auto reviews are currently disabled in this repository.
A successful CodeRabbit check may represent a skipped/no-op execution and is
not evidence that a code review occurred.
Codex quota-exhausted notifications are not reviews or findings.

This reference only describes the current state; it does not replace the general judgment logic below. Even if CodeRabbit is re-enabled in the future, you must still check whether a review was actually produced.

### VALID REVIEW

A review is valid only when all of the following hold:

- It actually produced a concrete code finding, an inline review comment, an unresolved review thread, or a formal review verdict.
- The review corresponds to the PR's current exact head SHA.
- There is no quota exhausted, disabled, skipped, cancelled, timed out, or other explicitly not-executed status.

### NOT A REVIEW

The following are always treated as "review not executed", not review findings:

- Codex quota exhausted.
- CodeRabbit review skipped.
- Auto reviews disabled.
- Cancelled, timed out, or other explicit bot indication that no review was executed.
- A `SUCCESS` check that is actually a skip/no-op.
- Only an issue-level bot notice with no finding, inline comment, review thread, or formal verdict.

`NOT A REVIEW` must never:

- Count as a reviewer.
- Count as an `APPROVE`.
- Count as a blocking finding.
- Trigger code modification, address-comments, or resolve-thread.

When such a notice arrives after the PR has already been merged, treat it as a no-op: do not modify code, reply to threads, or change the PR. Judgment must be based on whether a review actually ran and whether findings exist, not solely on the bot name, and must not hard-code specific PR numbers.

### Merge gate

The merge gate must be assessed separately:

- Whether CI checks such as build/test/lint succeeded.
- Whether a valid reviewer verdict exists.
- Whether unresolved review threads exist.
- Whether the reviewer verdict corresponds to the current exact head SHA.
- Whether an automated review actually ran.

A `SUCCESS` on an automated-review check must not be equated with a valid `APPROVE`. If an automated review did not run but a policy-compliant independent reviewer has already issued a formal `APPROVE`, that must not block the merge; the report must accurately note that the automated review did not run.

### Status output

Report automated-review status using the following formats; never write a skipped check as `SUCCESS` (unless valid review content was actually obtained):

```text
CodeRabbit: SKIPPED / NOT A REVIEW
Codex review: NOT RUN — QUOTA EXHAUSTED
Independent reviewer: APPROVE
```
