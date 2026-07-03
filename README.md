# tachi-lens

Twitch 聊天室沉浸式翻譯 Chrome Extension，支援 Gemini、DeepSeek、OpenAI、Claude API。

## 功能

- 在 Twitch 聊天室即時翻譯訊息
- 三種顯示模式（皆保留原文）：原文下方附加 / Hover 顯示 / 折疊原文
- 支援多家 LLM API，可在 Popup 自由切換 Provider 與模型
- 自備 API Key（BYOK），金鑰僅存於本機
- 批次翻譯 + 快取，避免頻繁 API 呼叫

## 技術棧

- TypeScript + Vite + pnpm
- Chrome Extension Manifest V3
- React (Popup only)
- Content Script 純 TS，輕量注入 Twitch DOM

## 開發

```bash
pnpm install
pnpm dev        # 開發模式：持續輸出到 dist/
pnpm build      # 正式建置
```

## 安裝到 Chrome

1. 執行 `pnpm build` 產生 `dist/`。
2. 打開 `chrome://extensions`。
3. 開啟「開發人員模式」。
4. 點「載入未封裝項目」。
5. 選擇專案底下的 `dist/` 資料夾，不要選 repo 根目錄。

若載入 repo 根目錄，Chrome 會直接讀到 `src/popup/index.html` 裡的 `main.tsx`，popup 會無法執行 React，常見現象就是只出現一個白色小方塊。

## 架構

```
src/
  background/     # Service Worker — API 呼叫、批次佇列、快取
  content/        # Content Script — MutationObserver、DOM 注入
  popup/          # React Popup — 設定 UI、Provider 切換
  providers/      # TranslationProvider 介面 + Gemini/DeepSeek/OpenAI/Claude adapter
  storage/        # chrome.storage 封裝
  shared/         # 共享型別、訊息協定、快取工具
```

## License

MIT
