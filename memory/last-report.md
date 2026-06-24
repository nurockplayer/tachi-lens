# PR-14: 錯誤 UI 處理

## 完成項目

### i18n 補齊 (`src/shared/i18n.ts` + `public/_locales/`)
- 新增 8 個 MessageKey: `errorAuth`, `errorRateLimited`, `errorTimeout`, `errorNetwork`, `errorUnsupportedModel`, `errorUnknown`, `errorNotificationTitle`, `dismiss`
- 更新 `en/messages.json` 和 `zh_TW/messages.json` locale 檔案
- `t()` 函數支援所有新 key

### 訊息協定 (`src/shared/messages.ts`)
- 新增 `ErrorNotification` payload type (id, type, message, timestamp)
- 新增 `isErrorNotificationMessage()` type guard

### Content Script 錯誤顯示強化 (`src/content/twitch-handler.ts`)
- `injectError()` 支援多種錯誤類型與對應圖示/顏色：
  - `auth`: 🔑 (#e74c3c)
  - `rate_limited`: ⏳ (silent retry, 不 injection)
  - `timeout`: ⏰ (#e67e22)
  - `network`: 🌐 (#9b59b6)
  - `unsupported_model`: ⚙️ (#3498db)
  - `unknown`: ⚠️ (#95a5a6)
- `injectTranslation()` 支援 displayMode (below/hover/collapse)
- 新增 `ContentSettings` type（取代 `MessageFilter`），含 `displayMode` + `translationEnabled`

### Popup 錯誤通知區域 (`src/popup/App.tsx`)
- 監聽 `chrome.runtime.onMessage` 的 `error_notification` 事件
- 在 Popup 底部顯示錯誤通知列表，最多 20 筆
- 支援個別關閉 (dismiss)
- 所有字串改為使用 `t()` 函數

## 驗證狀態
- `pnpm test`: 202 tests passed, 16 files
- `pnpm typecheck`: passed

## 修改檔案
- `src/shared/i18n.ts` (new), `src/shared/i18n.test.ts` (new)
- `src/shared/messages.ts`, `src/shared/messages.test.ts`
- `src/content/twitch-handler.ts`, `src/content/twitch-handler.test.ts`
- `src/content/twitch-entry.ts`
- `src/popup/App.tsx`, `src/popup/App.test.tsx`
- `public/_locales/en/messages.json` (new)
- `public/_locales/zh_TW/messages.json` (new)

## 殘餘風險
- 無。所有測試通過、typecheck 通過。
