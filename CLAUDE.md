# tachi-lens

Twitch 聊天室沉浸式翻譯 Chrome Extension。Manifest V3、BYOK，支援 Gemini、DeepSeek、OpenAI、Claude。

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | 安裝本地依賴；CI 使用 `pnpm install --frozen-lockfile` |
| `pnpm dev` | Vite watch build，輸出至 ignored `dist/` |
| `pnpm test` | 執行完整 Vitest suite |
| `pnpm typecheck` | TypeScript strict type check |
| `pnpm build` | Typecheck、production build、popup CSP check |

## Architecture

```text
src/background/  Service Worker：API key、provider 呼叫、batch/cache/rate limit、message routing
src/content/     Twitch DOM observer、filter、translation queue、非破壞式 DOM 注入
src/popup/       React 設定與診斷 UI
src/providers/   Provider adapters、registry、prompt contract
src/storage/     chrome.storage 封裝與設定 schema
src/shared/      SW/Content/Popup 共用 message protocol 與 i18n
```

資料流：Content Script 只傳 `{messageId, text, priority?}` 給 Service Worker；Service Worker 讀取設定與完整 API key、執行翻譯，再回傳結果；Popup 透過 trusted storage wrapper 管理非敏感設定，並透過 runtime messages 管理 API key、key preview 與 diagnostics。

## Runtime and security invariants

- 完整 API key 只由 Service Worker 讀取，且只存於 `chrome.storage.local`；Content Script 與 Popup 不得直接取得完整 key。
- Content Script 不直接讀 storage；跨 context 資料一律走 `src/shared/messages.ts` 的 runtime protocol 與 type guards。
- 翻譯 UI 保留 Twitch 原文，不 replace message body。
- Twitch selectors 集中於 `src/content/twitch-selectors.ts`；fallback collection 必須合併去重，不能只取第一種 DOM variant。
- Extension context invalidation 是 terminal lifecycle；一般 provider/network error 依既有 retry/processed contract 處理。
- Diagnostics 不得包含聊天室原文、username 或 API key。

## Development rules

- 使用 pnpm；保留 `pnpm-lock.yaml`，不得新增其他 lockfile 或 package-manager lifecycle enforcement script。
- TypeScript 維持 strict；測試與 source colocate，bug fix 先新增會失敗的 regression test。
- React 只用於 Popup；Content Script 保持原生 TypeScript/DOM。
- frontend page 設計或 redesign 前先使用 `design-taste-frontend`；Popup 等密集產品 UI 以既有 design system 與 task ergonomics 為優先。
- 不提交 `dist/`、`.omc` session/state noise、release zip 或其他 generated artifact。

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

- GitHub Issue 是 implementation source of truth；每個 PR 聚焦一個明確問題，額外需求另開 issue/PR。
- `docs/` research、notes、plans 只提供背景，除非 issue 明確引用，否則不是 implementation source of truth。
- 專案使用 `main` 作為 PR base；不要套用其他專案的 develop/release branch model。
- 所有 git/gh shell command 使用 `rtk git ...` / `rtk gh ...`；pnpm、測試與一般 shell command 不加 `rtk`。
- Push、PR、issue comment、label、merge 等 public state change 需要使用者明確授權。
- 技術問題與重要權衡要留在相關 Issue 或 PR，不只存在聊天記錄。

## Agent workflow

- Issue tracker 操作見 `docs/agents/issue-tracker.md`；治理 pattern 決策見 `docs/agents/governance.md`。
- Broad scan、diff grouping、log summary 與 test draft 優先交給 DeepSeek worker；controller 必須重讀引用檔案並驗證重要 claim。
- Controller 負責實際 edit、test、security/architecture judgment、commit/push/PR 與最終使用者結論。
- Worker/外部模型不得負責 destructive command、public state change 或最終 approval。
- GSD yolo mode 只控制 planning convenience 與 phase auto-advance，不得授權跳過 issue scope、delivery gates 或 public-state-change 授權；見 `docs/agents/gsd-workflow.md`。

## Automated review validation

本節規範 Controller 如何判定 PR 上的 automated review（CodeRabbit、chatgpt-codex-connector 等 bot）是否真的執行過，避免把「沒有實際執行審查」的 bot 通知誤判為有效 review 或 review finding。

### Repository reference

CodeRabbit auto reviews are currently disabled in this repository.
A successful CodeRabbit check may represent a skipped/no-op execution and is
not evidence that a code review occurred.
Codex quota-exhausted notifications are not reviews or findings.

此 reference 只描述目前狀態，不得取代下列一般判斷邏輯。即使未來 CodeRabbit 重新啟用，仍必須檢查是否真的產生 review。

### VALID REVIEW

只有同時符合以下條件，才視為有效 review：

- 實際產生具體 code finding、inline review comment、unresolved review thread 或正式 review verdict。
- 審查對應 PR 當前 exact head SHA。
- 沒有 quota exhausted、disabled、skipped、cancelled、timed out 或其他明確未執行狀態。

### NOT A REVIEW

以下情況一律視為「審查未執行」，不是 review finding：

- Codex quota exhausted／額度用盡。
- CodeRabbit review skipped。
- Auto reviews disabled。
- Cancelled、timed out 或其他 bot 明確表示未執行審查。
- `SUCCESS` check 實際上是 skip／no-op。
- 只有 issue-level bot 通知，沒有 finding、inline comment、review thread 或正式 verdict。

`NOT A REVIEW` 一律不得：

- 算作 reviewer。
- 算作 `APPROVE`。
- 算作 blocking finding。
- 觸發 code modification、address-comments 或 resolve-thread。

PR 已 merged 後才收到此類通知時，判定為 no-op：不得修改程式、回覆 thread 或改動 PR。判斷必須以「review 是否實際執行、是否存在 findings」為主，不得只以 bot 名稱作為唯一依據，也不得硬編碼特定 PR 編號。

### Merge gate

Merge gate 必須分開判定：

- Build／test／lint 等 CI checks 是否成功。
- 是否存在有效 reviewer verdict。
- 是否存在 unresolved review threads。
- reviewer verdict 是否對應當前 exact head SHA。
- automated review 是否真的執行。

Automated-review check 的 `SUCCESS` 不得自行等同有效 `APPROVE`。若 automated review 未執行，但已有符合政策的獨立 reviewer 正式 `APPROVE`，不得因此阻擋 merge；報告中必須如實標示 automated review 未執行。

### 狀態輸出

報告中 automated review 狀態使用下列格式，不得把 skipped check 寫成 `SUCCESS`（除非確實取得有效 review 內容）：

```text
CodeRabbit: SKIPPED / NOT A REVIEW
Codex review: NOT RUN — QUOTA EXHAUSTED
Independent reviewer: APPROVE
```
