# GSD workflow: planning-only yolo mode

```yaml
status: active
source_project: tachi-lens
last_verified: 2026-08-07
applies_when: GSD drives implementation work inside tachi-lens
```

This document defines the responsibility boundary between GSD yolo mode and the repository's existing implementation, validation, review, and public-state-change workflows. `docs/agents/governance.md` records the adoption status of this policy.

## Scope of GSD yolo mode

GSD yolo mode only controls **planning convenience** and **phase auto-advance**:

- It allows GSD to quickly create/update planning artifacts and advance automatically per the workflow phase.
- It must neither expand nor shrink the issue scope, nor authorize any delivery gate to be skipped.

The current `.planning/config.json` settings `plan_check: false`, `verifier: false`, `auto_advance: true` belong to the planning layer. These flags do **not** authorize skipping any of the following:

- Issue scope and repository rules (`CLAUDE.md`/`AGENTS.md`).
- Tests, typecheck, build.
- Security review.
- `/codex:review`.

## Source of truth

- A GitHub Issue is the implementation source of truth.
- Planning artifacts, research notes, and plans produced by GSD only provide background and context; unless an Issue explicitly references them, they are not implementation requirements.
- Any scope change or expansion always opens another Issue/PR instead of being written directly into the current work.

## Worker and controller responsibility split

A Worker (subagent, background agent) may, within a bounded child issue:

- inspect (investigate, read files)
- draft (outline, produce drafts)
- implement (implement within a clearly defined sub-scope)

But the controller must:

- Re-read and verify referenced files (do not trust the worker's summary directly).
- Execute commands personally (build, tests, lint, typecheck).
- Review the full diff.
- Own all public state changes (push, PR, issue comment, label, merge).
- Make the final security/architecture judgment.

A Worker's output is only evidence/draft and carries no final risk judgment or external publication authority.

## Public state changes require explicit authorization

The following operations still require explicit user authorization; GSD must not perform them automatically:

- `git push`
- PR creation and updates
- Issue comments
- Label changes
- Merge

Until authorized, the controller must not perform any of the above.

## Delivery gates

- Any failed validation (tests, typecheck, build, `git diff --check`) will **block push and PR publication**.
- Any actionable review finding will **block push and PR publication**; it must be fixed and re-reviewed until there are no actionable findings.
- The PR body must include the final review result, validation results, and confirmation that the GSD configuration and extension runtime were not changed.

## Auto-advance boundary

GSD must not auto-advance into work beyond the active issue:

- Phase auto-advance only proceeds within the scope of the same active issue.
- Before entering a new issue, requirement, or scope, it must stop and wait for explicit direction from the user or controller.
