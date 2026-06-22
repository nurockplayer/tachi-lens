# tachi-lens — Twitch 聊天室沉浸式翻譯 Chrome Extension

## 專案概覽

Chrome Extension MV3，BYOK（自備 API Key），支援 Gemini/DeepSeek/OpenAI/Claude 四家翻譯 provider。

## 已完成的 Issue

- **#1** — 基礎架構（pnpm + Vite 8 + TypeScript strict + CRXJS build + CI）
- **#10 (TDD 部分)** — 5 個測試檔、22 個測試通過（message guards、settings、registry、prompt、SW init）
- **#6 (Security 部分)** — Storage access level 限制、API key save/rotate/delete/masked、runtime state persistence

## 目前架構狀態

```
src/
  background/
    service-worker.ts        — SW 入口，啟動時呼叫 initializeStorageAccess()
    service-worker.test.ts
  content/
    twitch-entry.ts          — CS 入口（placeholder，待 #2）
    twitch-selectors.ts      — DOM selector contract
  popup/
    App.tsx, main.tsx, index.html  — React placeholder（待 #5）
  providers/
    types.ts                 — TranslationProvider 介面 + ProviderId 型別
    registry.ts              — Provider registry + runtime 驗證
    registry.test.ts
    prompt.ts                — 翻譯 prompt 模板
    prompt.test.ts
  storage/
    settings.ts              — chrome.storage 封裝（key/設定/RuntimeState）
    settings.test.ts
  shared/
    messages.ts              — 訊息協定型別 + runtime type guards
    messages.test.ts
```

## 核心設計決策

| 決策 | 內容 |
|------|------|
| **架構** | MV3 Content Script + Service Worker + Popup，不 replace Twitch 聊天室 |
| **BYOK** | 使用者裝 Extension 後自行填入 Key，僅存 chrome.storage.local |
| **翻譯 UI** | 預設原文下方附加一行翻譯，非破壞式 |
| **Provider** | TranslationProvider 開放介面，registry 集中註冊 + endpoint allowlist |
| **API Key 安全** | SW 唯一讀取完整 key，CS 只送 `{messageId, text}`，setAccessLevel 限制 |
| **錯誤處理** | ProviderError discriminated union（auth/rate_limited/quota/bad_request/network/timeout/unknown） |
| **快取 key** | `text_hash + target_lang + provider + model + prompt_version` |
| **技術棧** | pnpm + Vite 8 + TypeScript strict + React (Popup only) + Vitest |

## 待實作 Issue（照建議順序）

1. **#4** — Provider adapter 實作（Gemini → DeepSeek → OpenAI → Claude）
2. **#3** — Service Worker 訊息路由 + 批次佇列 + 快取
3. **#7** — Rate limit backoff + 流量控制
4. **#8** — Twitch DOM selector 實地驗證
5. **#2** — Content Script MutationObserver + 過濾 + 注入
6. **#5** — Popup React UI
7. **#9** — i18n 多語言
8. **#14** — 錯誤 UI 處理
9. **#11** — 多頁面支援
10. **#12** — 每頻道設定
11. **#13** — 快捷鍵
