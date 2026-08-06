# GSD workflow: planning-only yolo mode

```yaml
status: active
source_project: tachi-lens
last_verified: 2026-08-07
applies_when: GSD drives implementation work inside tachi-lens
```

本文件定義 GSD yolo mode 與本 repo 既有 implementation、validation、review、public-state-change workflow 之間的責任邊界。`docs/agents/governance.md` 記錄此 policy 的採用狀態。

## GSD yolo mode 的範圍

GSD yolo mode 只控制 **planning convenience** 與 **phase auto-advance**：

- 允許 GSD 快速建立/更新 planning artifact、依照 workflow phase 自動前進。
- 不得擴大或縮小 issue scope，也不得授權任何 delivery gate 被跳過。

`.planning/config.json` 目前的 `plan_check: false`、`verifier: false`、`auto_advance: true` 屬於 planning 層設定。這些旗標**不授權**跳過下列任何一項：

- Issue scope 與 repository rules（`CLAUDE.md`／`AGENTS.md`）。
- Tests、typecheck、build。
- Security review。
- `/codex:review`。

## Source of truth

- GitHub Issue 是 implementation source of truth。
- GSD 產生的 planning artifact、research notes 與 plan 只提供背景與脈絡；除非 Issue 明確引用，否則不是 implementation requirement。
- 對 scope 的變更或擴大一律另開 Issue/PR，不直接寫入目前的工作。

## Worker 與 controller 責任分工

Worker（subagent、背景 agent）在 bounded child issue 內可以：

- inspect（調查、讀取檔案）
- draft（擬稿、產出草稿）
- implement（在明確定義的子範圍內實作）

但 controller 必須：

- 重讀並驗證 referenced files（不直接信任 worker 的摘要）。
- 親自執行命令（build、tests、lint、typecheck）。
- 審查完整 diff。
- 負責所有 public state changes（push、PR、issue comment、label、merge）。
- 做最終 security／architecture judgment。

Worker 的輸出只是 evidence／draft，不具備最終風險判斷或對外發布權限。

## Public state changes 需明確授權

下列操作仍然要求使用者明確授權，GSD 不得自動執行：

- `git push`
- PR 建立與更新
- Issue comment
- Label 變更
- Merge

未獲授權前，controller 不得執行上述任何操作。

## Delivery gates

- 任何一次 failed validation（tests、typecheck、build、`git diff --check`）都會 **block push 與 PR publication**。
- 任何 actionable review finding 都會 **block push 與 PR publication**；必須修正後再重新 review，直到沒有 actionable findings。
- PR body 必須包含最終 review 結果、validation 結果，以及 GSD configuration 與 extension runtime 未被變更的確認。

## Auto-advance 邊界

GSD 不得 auto-advance 到 active issue 以外的 work：

- phase auto-advance 只能在同一 active issue 的範圍內進行。
- 進入新 issue、新需求或新 scope 前必須停止，等待使用者或 controller 明確指示。
