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
