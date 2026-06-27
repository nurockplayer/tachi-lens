# Roadmap: tachi-lens

12 phases · 32 requirements · All complete ✓

## Milestone v0.1: Foundation & Core

### Phase 1: Infrastructure & Security
**Goal:** 專案 scaffolding + CI + storage security
**Mode:** mvp
**Requirements:** ENV-01, SEC-01, SEC-02
**Success Criteria:**
1. CI 通過 lint + typecheck + 測試
2. API Key 僅存 chrome.storage.local，僅 SW 可讀取完整 key

**Status:** ✅ Complete

### Phase 2: Provider Adapters
**Goal:** Gemini / DeepSeek / OpenAI / Claude 四家 Provider adapter
**Mode:** mvp
**Requirements:** ADPT-01 ~ ADPT-05
**Success Criteria:**
1. 每家 Provider 可 translateBatch + validateKey
2. registry 可正確註冊與建立實例

**Status:** ✅ Complete

### Phase 3: SW Routing + Queue + Cache
**Goal:** SW 訊息路由、批次佇列、LRU+TTL 快取
**Mode:** mvp
**Requirements:** SW-01 ~ SW-03
**Success Criteria:**
1. translate_request 正確路由到 provider
2. debounce 150ms + max 10 條/批次
3. 快取 hit 直接返回，miss 加入批次

**Status:** ✅ Complete

### Phase 4: Rate Limit Backoff
**Goal:** 指數退避 + 自動重試
**Mode:** mvp
**Requirements:** SW-04, SW-05
**Success Criteria:**
1. rate_limited 錯誤觸發退避
2. 最多 3 次重試後放棄

**Status:** ✅ Complete

### Phase 5: DOM Selectors
**Goal:** Twitch DOM selector contract + 整合測試
**Mode:** mvp
**Requirements:** CS-01, CS-02
**Success Criteria:**
1. channel / popout / vod / clip 四種頁面 selector 正確
2. 整合測試通過

**Status:** ✅ Complete

### Phase 6: Content Script
**Goal:** MutationObserver + 過濾 + 翻譯注入
**Mode:** mvp
**Requirements:** CS-03 ~ CS-05
**Success Criteria:**
1. 新訊息即時觸發翻譯
2. 三種顯示模式正確運作
3. 定時重試 rate_limited 訊息

**Status:** ✅ Complete

### Phase 7: Popup UI
**Goal:** React 設定表單 + API Key 管理
**Mode:** mvp
**Requirements:** POPUP-01, POPUP-02
**Success Criteria:**
1. 可選擇 Provider / Model / 語言
2. 可輸入/遮罩/刪除 API Key
3. 可驗證 Key 有效性

**Status:** ✅ Complete

### Phase 8: i18n
**Goal:** 多語言支援
**Mode:** mvp
**Requirements:** I18N-01 ~ I18N-03
**Success Criteria:**
1. en / zh_TW locale 完整
2. 每條 key 在兩個 locale 都有對應

**Status:** ✅ Complete

### Phase 9: Multi-page Support
**Goal:** 支援 clip 頁面 + SPA 導航
**Mode:** mvp
**Requirements:** CS-06
**Success Criteria:**
1. clip 頁面正確偵測
2. SPA 導航時 observer 重啟

**Status:** ✅ Complete

### Phase 10: Per-channel Settings
**Goal:** 每頻道獨立設定
**Mode:** mvp
**Requirements:** POPUP-03
**Success Criteria:**
1. Popup 顯示目前頻道名稱
2. 可啟用/停用每頻道設定
3. 設定合併邏輯正確

**Status:** ✅ Complete

### Phase 11: Keyboard Shortcuts
**Goal:** 快捷鍵 + 設定廣播
**Mode:** mvp
**Requirements:** KB-01 ~ KB-03
**Success Criteria:**
1. Ctrl+Shift+T 切換翻譯
2. Ctrl+Shift+M 切換顯示模式
3. 設定變更即時廣播到所有 CS tabs

**Status:** ✅ Complete

### Phase 12: Error UI
**Goal:** 錯誤 UI 圖示 + Popup 通知中心
**Mode:** mvp
**Requirements:** CS-07, POPUP-04
**Success Criteria:**
1. 翻譯錯誤在訊息旁顯示圖示
2. Popup 顯示錯誤通知列表
3. rate_limited 不標記 processed（可重試）

**Status:** ✅ Complete
