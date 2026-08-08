# Issue tracker: GitHub

GitHub Issues are the source of truth for requirements and defects. All GitHub CLI operations use `rtk gh`.

## Commands

- Read: `rtk gh issue view <number> --comments`
- List: `rtk gh issue list`
- Create: `rtk gh issue create`
- Comment: `rtk gh issue comment <number> --body "..."`
- Edit: `rtk gh issue edit <number> ...`
- Close: `rtk gh issue close <number> --comment "..."`

## Rules

- Technical issues, scope changes, or design trade-offs that have a corresponding Issue must leave a traceable record in that Issue or the implementing PR.
- PRs are not an inbox for external requirements; unconfirmed external PRs do not enter the agent triage queue.
- Do not assume custom triage labels exist; verify with `rtk gh label list` before using a label.
- Additional functionality not requested by the Issue opens another Issue; do not fold it into the current PR.

## Specification metadata

A GitHub Issue remains the unit of execution; a lightweight Spec is needed only when a shared-contract situation or high-impact correctness semantics (migration/compatibility/rollout/privacy/security/concurrency/release-transaction) need to be frozen before implementation. See "Spec and implementation routing" in `CLAUDE.md`/`AGENTS.md` and `docs/agents/governance.md` for the three levels and the freeze semantics.

The Issue's `## Specification` section uses the following metadata convention:

- `Spec: N/A` — Level 0, the default for bounded independent work; no Spec artifact required.
- `Spec: Inline — this issue` — Level 1, the contract is frozen in the owner/parent Issue without a repository Spec file.
- `Spec: docs/specs/<name>.md` — Level 2, a durable contract shared across multiple Issues or persisting across waves; the spec lives in `docs/specs/`.

An Issue carries exactly one level; the Spec defines the what across implementation boundaries, while the Issue still defines the atomic change such as scope/AC/validation. Once multiple Issues are dispatched against the same shared Spec, the contract is frozen; if a contract error or a conflict with `main` is found, report **SPEC BLOCKER** and do not silently reinterpret or rewrite it. Legacy/closed Issues do not need a `## Specification` section.

## Review compliance

A final/adversarial review must verify that the exact-head implementation completely satisfies this Issue's scope, acceptance criteria, and any referenced/current Spec, not only code quality or regressions. For each relevant Acceptance Criterion, classify it as `SATISFIED`, `PARTIALLY SATISFIED`, `MISSING`, or `N/A`; a `PARTIALLY SATISFIED` or `MISSING` required criterion is a review finding even when the code itself appears correct. Findings may include missing requirements, incomplete acceptance criteria, Spec violations, scope/non-goal violations, or insufficient validation evidence. Any semantic change after review invalidates the prior compliance verdict and requires re-review. See `docs/agents/governance.md` → "Final/adversarial review contract" for the full contract, including the review precedence chain and preserved policy.
