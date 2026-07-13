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

資料流：Content Script 只傳 `{messageId, text}` 給 Service Worker；Service Worker 讀取設定與完整 API key、執行翻譯，再回傳結果；Popup 透過 runtime messages 管理設定、key preview 與 diagnostics。

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
- 不提交 `dist/`、`.omc` session/state noise、release zip 或其他 generated artifact。

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
