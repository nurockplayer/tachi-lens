# Agent governance pattern decisions

```yaml
status: active
source_project: tachigo
last_verified: 2026-07-13
applies_when: Claude Code and Codex both work in tachi-lens
```

本文件記錄跨專案 pattern 在 tachi-lens 的採用狀態。Repo 明確規則永遠優先於 reference 或 corpus precedent。

## Adopted

- **CLAUDE.md + AGENTS.md dual entrypoints**：兩者鏡像 scope、Git、安全邊界與 AI collaboration responsibility，避免 policy drift。
- **Scope pollution guard**：GitHub Issue 是 source of truth；額外需求另開 Issue/PR；research/plan 不自動成為 implementation requirement。**Spec 不是 requirements pipeline**：shared-contract 情境下的 lightweight Spec 只定義跨實作邊界的 what，atomic change 仍由 Issue 定義，`Spec: N/A` 是 bounded 獨立工作的預設。
- **Traceable problem reporting**：技術障礙、重要權衡與 workaround 記錄在相關 Issue/PR。
- **Controller verification**：worker 只提供 evidence/draft，controller 重讀本地檔案並負責最終風險判斷。
- **GSD planning-only workflow**：GSD yolo mode 只控制 planning convenience 與 phase auto-advance，不授權跳過 issue scope、validation、security review 或 `/codex:review`。完整責任邊界見 [`docs/agents/gsd-workflow.md`](gsd-workflow.md)。
- **Selective Lightweight SDD**：Issue 仍是執行單位，只有共享 contract 情境才引入 lightweight spec；三層 level（`N/A` / `Inline` / `docs/specs/`）、source-of-truth precedence 與平行 freeze 語意見 `CLAUDE.md`／`AGENTS.md` 的「Spec and implementation routing」。

## Rejected for this repository

- **tachigo `develop → main` Git flow**：tachi-lens 目前採單一 `main` PR base，沒有 release promotion 需求。
- **Fixed issue/title prefixes**：目前 repo 沒有對應 automation contract，先不引入無法驗證的命名政策。
- **Scope-police auto-close、review labels、Dependabot auto-approve**：高影響 automation 未獲明確授權，保持停用。
- **Permanent implementation plans**：完成後由 Issue、tests 與 Git history 承接；過期 plan 容易被誤認為現況。
- **Per-session `memory/last-report.md` updates in this cleanup**：使用者指定恢復現有 tracked report，避免把本次 session handoff 混入產品 PR。
