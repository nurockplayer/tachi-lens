# PR #13 — 快捷鍵

## 完成項目

- **manifest.json**: 新增 `commands` 區塊，定義 `toggle-translation`（Ctrl+Shift+T）與 `toggle-display-mode`（Ctrl+Shift+M）
- **Service Worker**: 監聽 `chrome.commands.onCommand`，處理兩個指令的 toggle 邏輯，變更後廣播 `settings_updated` 給所有 content script tabs
- **Content Script** (`twitch-entry.ts`): 監聽來自 SW 的 `settings_updated` 訊息，合併更新到 `chrome.storage.local`
- **Popup UI** (`App.tsx`): 底部新增快捷鍵資訊區塊
- **i18n** (`src/shared/i18n.ts`): 新增快捷鍵標籤的 i18n 函式 `t()` 與 `getShortcutLabel()`
- **Message Protocol** (`src/shared/messages.ts`): 新增 `settings_updated` 型別與 `isSettingsUpdateMessage` guard
- **Chrome i18n**: `public/_locales/en/messages.json` 與 `public/_locales/zh_TW/messages.json`

## 驗證狀態

- `pnpm test`: ✅ 17 test files, 160 tests passed
- `pnpm typecheck`: ✅ 無錯誤
- 分支已推送: `pr/13-hotkeys`

## 殘餘風險

- 快捷鍵在部分作業系統/瀏覽器上可能需要額外設定才能覆蓋既有快捷鍵（如 Ctrl+Shift+T 在部分瀏覽器是重新開啟已關閉分頁）
- content script 的設定更新暫無主動通知 UI 更新的機制（popup 重新打開時會讀取最新設定）
