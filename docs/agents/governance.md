# Agent governance pattern decisions

```yaml
status: active
source_project: tachigo
last_verified: 2026-07-13
applies_when: Claude Code and Codex both work in tachi-lens
```

This document records the adoption status in tachi-lens of patterns that originate from other projects. Explicit repository rules always take precedence over reference or corpus precedent.

## Adopted

- **CLAUDE.md + AGENTS.md dual entrypoints**: the two mirror scope, Git, security boundaries, and AI collaboration responsibilities to avoid policy drift.
- **Scope pollution guard**: a GitHub Issue is the source of truth; additional requirements open another Issue/PR; research/plans do not automatically become implementation requirements. **Spec is not a requirements pipeline**: in shared-contract situations, the lightweight Spec only defines the what across implementation boundaries, while the atomic change is still defined by the Issue, and `Spec: N/A` is the default for bounded independent work.
- **Traceable problem reporting**: technical obstacles, important trade-offs, and workarounds are recorded in the relevant Issue/PR.
- **Controller verification**: workers only provide evidence/drafts; the controller re-reads local files and owns the final risk judgment.
- **GSD planning-only workflow**: GSD yolo mode only controls planning convenience and phase auto-advance; it does not authorize skipping issue scope, validation, security review, or `/codex:review`. See [`docs/agents/gsd-workflow.md`](gsd-workflow.md) for the full responsibility boundary.
- **Selective Lightweight SDD**: the Issue remains the unit of execution; a lightweight spec is introduced only when a shared-contract situation or high-impact correctness semantics (migration/compatibility/rollout/privacy/security/concurrency/release-transaction) need to be frozen before implementation; see "Spec and implementation routing" in `CLAUDE.md`/`AGENTS.md` for the three levels (`N/A` / `Inline` / `docs/specs/`), source-of-truth precedence, and the parallel-freeze semantics.
- **Spec/Issue-aware final review**: a final/adversarial review verifies exact-head compliance with the authoritative GitHub Issue and any referenced/current Spec, not only code quality or regressions; see the review contract below.

## Final/adversarial review contract

A final/adversarial review must not review only code quality or regressions. It must verify that the exact-head implementation completely satisfies the authoritative GitHub Issue and any referenced/current Spec. This contract extends the existing "Automated review validation" rules in `CLAUDE.md`/`AGENTS.md` and the Selective Lightweight SDD levels defined above; it does not weaken them.

### Review precedence

The reviewer evaluates the change against the following precedence chain:

`repository rules → referenced/current Spec → Issue scope + acceptance criteria → exact-head implementation/diff/tests → PR claims`

### Required verification

For the exact head, the reviewer must explicitly verify:

- every Acceptance Criterion is satisfied
- required behavior and invariants are implemented
- referenced Spec contracts are preserved
- forbidden changes and non-goals are not violated
- dependency assumptions are valid
- test/validation evidence actually proves the requirement
- PR-body claims have repository evidence
- no requirement is only documented or claimed without implementation
- no implementation silently changes a frozen Spec contract

### Acceptance-criterion classification

For each relevant AC, classify it as:

- `SATISFIED`
- `PARTIALLY SATISFIED`
- `MISSING`
- `N/A`

A `PARTIALLY SATISFIED` or `MISSING` required criterion is a review finding even when the code itself appears correct.

### Finding types

Review findings may therefore be implementation defects, missing requirements, incomplete acceptance criteria, Spec violations, scope/non-goal violations, or insufficient validation evidence. Do not invent requirements outside the authoritative Issue/Spec.

### Exact-head rule

The Issue/Spec compliance review must correspond to the current exact head SHA. Any semantic change made after review invalidates the prior compliance verdict and requires re-review of the affected contract.

### Preserved policy

This contract does not weaken or replace Selective Lightweight SDD, the one-focused-Issue/PR rule, exact-head review, the foreground reviewer, Codex adversarial review, automated-review validation, CI gates, unresolved-thread handling, model routing, or public-state-change rules. The `VALID REVIEW` / `NOT A REVIEW` distinction in "Automated review validation" remains intact: this contract extends what a valid review must check, and it does not conflate "review actually ran" with "Issue/Spec compliance passed."

## Rejected for this repository

- **tachigo `develop → main` Git flow**: tachi-lens currently uses a single `main` PR base with no release promotion need.
- **Fixed issue/title prefixes**: the repository has no matching automation contract, so an unverifiable naming policy is not introduced for now.
- **Scope-police auto-close, review labels, Dependabot auto-approve**: high-impact automation lacks explicit authorization and stays disabled.
- **Permanent implementation plans**: completed work is carried by the Issue, tests, and Git history; stale plans are easily mistaken for current state.
- **Per-session `memory/last-report.md` updates in this cleanup**: the user specified restoring the existing tracked report to avoid mixing this session handoff into the product PR.

## Language inventory (post-migration, issue #120)

English is the canonical language for technical artifacts (see "Language policy" in `CLAUDE.md`/`AGENTS.md`). The following tracked content remains in Traditional Chinese and is either preserved intentionally or scheduled as touch-to-migrate:

**Preserved (language is product behavior / user-facing):**
- `public/_locales/en/messages.json`, `public/_locales/zh_TW/messages.json` — Chrome i18n localization resources.
- `src/shared/i18n.ts` — `t()` fallback locale map.
- `src/popup/App.tsx` `DIAGNOSTIC_LABELS` and content-script diagnostic messages (`src/content/twitch-entry.ts`, `src/content/twitch-handler.ts`) — rendered to the popup UI for users.
- `manifest.json` / `package.json` `description` — store/registry user-facing copy.
- Language-detection fixtures and all translation test data (Chinese/Japanese/Korean strings in tests) — language is product behavior.

**Touch-to-migrate (legacy or planning artifacts; translated only when actively modified):**
- `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md` — GSD planning artifacts, not requirements sources.
- `docs/releases/v0.2.0-beta.1.md`, `docs/releases/v0.2.0-beta.2.md` — published historical release notes (do not rewrite history).
- `src/content/twitch-selectors-notes.md` — historical DOM-selector verification notes; migrate when next maintained.

Historical commits, closed issues, and closed PRs are excluded per the issue scope.
