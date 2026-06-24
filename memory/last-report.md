# last-report — #12 每頻道設定

## 完成項目

### Storage (`src/storage/settings.ts`)
- 新增 `PerChannelSettings` 型別 (`Record<string, Partial<UserSettings>>`)
- 新增 `PER_CHANNEL_SETTINGS_STORAGE_KEY = 'perChannelSettings'`
- 新增 `getPerChannelSettings()` — 讀取所有頻道設定
- 新增 `getChannelSettings()` — 讀取特定頻道設定
- 新增 `saveChannelSettings()` — 儲存頻道設定
- 新增 `deleteChannelSettings()` — 刪除頻道設定
- 新增 `mergeSettings()` — 合併全域與頻道設定（頻道優先）

### Content Script (`src/content/twitch-handler.ts` + `twitch-entry.ts`)
- 新增純函數 `parseChannelFromPathname()` 從 pathname 解析頻道名稱
- `TwitchMessageHandler.getChannelName()` 方法
- `twitch-entry.ts` 的 `getFilter()` 現在會合併全域 + 頻道設定

### Popup (`src/popup/App.tsx`)
- 新增 `extractChannelFromUrl()` 純函數，從完整 URL 解析 Twitch 頻道名稱
- 顯示當前頻道名稱區塊
- 新增「使用此頻道的專用設定」checkbox
- 啟用時儲存到 per-channel storage，停用時儲存到全域

## 驗證狀態
- `pnpm test`: **173 tests passed** (增加了 32 個新測試)
- `pnpm typecheck`: **passed**
- 修改檔案：`src/storage/settings.ts`, `src/storage/settings.test.ts`
- 修改檔案：`src/content/twitch-handler.ts`, `src/content/twitch-handler.test.ts`, `src/content/twitch-entry.ts`
- 修改檔案：`src/popup/App.tsx`, `src/popup/App.test.tsx`

## 殘餘風險
- **無 tests for content/twitch-entry.ts**：twitch-entry.ts 的 `getFilter()` 修改無自動化測試覆蓋，僅靠 mannual testing 驗證
- **Popup 無法在 node 環境 render**：App.test.tsx 在 node 環境執行，無法測試完整 component render（包含 channels UI），型別與 export 有測試但 render 行為需 mannual testing
- `chrome.tabs?.query` 在 service worker / background 不存在時不會 crash（optional chaining），但若 pure popup 場景無 active tab，頻道功能會 graceful degrade
- `mergeSettings` 使用 shallow spread，若未來 `UserSettings` 含巢狀物件可能需改 deep merge
