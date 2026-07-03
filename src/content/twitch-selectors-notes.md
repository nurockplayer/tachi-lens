# Twitch DOM Selector 實地驗證紀錄 (#8)

## 現有 Selectors（2026-06-24）

### Channel 頁面 (`twitch.tv/{channel}`)

| 用途 | Selector | 狀態 |
|------|----------|------|
| 聊天室容器 | `[data-test-selector="chat-scrollable-area__message-container"]` | ✅ data-test-selector 穩定 |
| 單則訊息 | `.chat-line__message` | ✅ 長期穩定 |
| 訊息內文 | `.chat-line__message-body` | ✅ 長期穩定 |
| 使用者名稱 | `.chat-author__display-name` | ✅ 長期穩定 |

### Popout 聊天室 (`twitch.tv/popout/{channel}/chat`)

| 用途 | Selector | 狀態 |
|------|----------|------|
| 聊天室容器 | `.chat-scrollable-area__message-container` | ⚠️ 推測，需實地驗證 |
| 單則訊息 | `.chat-line__message` | ✅ 與 channel 相同 |
| 訊息內文 | `.chat-line__message-body` | ✅ 與 channel 相同 |
| 使用者名稱 | `.chat-author__display-name` | ✅ 與 channel 相同 |

### VOD 頁面 (`twitch.tv/videos/{id}`)

| 用途 | Selector | 狀態 |
|------|----------|------|
| 聊天室容器 | `[data-test-selector="chat-scrollable-area__message-container"]` | ⚠️ 推測與 channel 相同，需實地驗證 |
| 單則訊息 | `.chat-line__message` | ✅ 與 channel 相同 |

## 實地驗證檢查清單

- [ ] Popout chat 容器 selector 是否正確（`.chat-scrollable-area__message-container`）
- [ ] Popout chat 訊息元素是否使用相同 class
- [ ] VOD 聊天室容器是否與 channel 相同
- [ ] VOD 聊天室是否在頁面載入後才 lazy-load
- [ ] 不同語言／地區子域名（`twitch.tv` vs `www.twitch.tv`）DOM 是否一致

## 更新方式

若 Twitch 變更 DOM，僅需修改 `twitch-selectors.ts` 中的 selector 字串，不需動到其他檔案。
