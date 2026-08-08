# Issue tracker: GitHub

GitHub Issues 是需求與缺陷的 source of truth。所有 GitHub CLI 操作使用 `rtk gh`。

## Commands

- Read: `rtk gh issue view <number> --comments`
- List: `rtk gh issue list`
- Create: `rtk gh issue create`
- Comment: `rtk gh issue comment <number> --body "..."`
- Edit: `rtk gh issue edit <number> ...`
- Close: `rtk gh issue close <number> --comment "..."`

## Rules

- 有對應 Issue 的技術問題、scope change 或設計權衡，必須在該 Issue 或實作 PR 留下可追溯紀錄。
- PR 不是外部需求收件匣；未經確認的外部 PR 不進 agent triage queue。
- 不假設 custom triage labels 存在；使用 label 前先以 `rtk gh label list` 查證。
- Issue 未要求的額外功能另開 Issue，不塞進目前 PR。

## Specification metadata

GitHub Issue 仍是執行單位；shared-contract 情境或高影響正確性語意（migration/compatibility/rollout/privacy/security/concurrency/release-transaction）需在實作前凍結時，才需要 lightweight Spec，三層 level 與 freeze 語意見 `CLAUDE.md`／`AGENTS.md` 的「Spec and implementation routing」與 `docs/agents/governance.md`。

Issue 的 `## Specification` section 使用下列 metadata convention：

- `Spec: N/A` — Level 0，bounded 獨立工作的預設，不要求 Spec artifact。
- `Spec: Inline — this issue` — Level 1，契約凍結在 owner/parent Issue，不建 repository Spec file。
- `Spec: docs/specs/<name>.md` — Level 2，多 Issues 共享或跨 wave 存續的 durable contract，spec 存於 `docs/specs/`。

一個 Issue 只標記一個 level；Spec 定義跨實作邊界的 what，Issue 仍定義 scope/AC/validation 等 atomic change。多個 Issues 對同一 shared Spec dispatch 後契約凍結，發現契約錯誤或與 `main` 衝突時回報 **SPEC BLOCKER**，不靜默 reinterpret/rewrite。Legacy/closed Issues 不需補 `## Specification` section。
