# 最後一次任務回報 — quota-denial fallback-unavailable retryability fix

## 完成了什麼

- 修復當 Gemini quota pre-flight 拒絕時，DeepSeek fallback 回傳 `auth`/`bad_request` 導致訊息被永久標記為已處理的 bug
- `finishDeepSeek()` 中 `!batch.geminiResults` 路徑新增保護：合成 `rate_limited`（status: 429, retryAfterMs: 30_000）取代 DeepSeek 錯誤，provider 標記為 `'gemini'`
- 非 auth/bad_request 的 fallback 結果維持不變；既有 `batch.geminiResults` merge 邏輯不受影響
- 新增 7 個 regression 測試（5 個 QuotaScheduler direct + 2 個 Translator 端到端）
- 測試全數通過（33 files, 513 tests）

## 殘餘風險

- 合成結果的 `retryAfterMs` 預設 30_000ms，非動態從 `nextAvailableAt` 計算；但此值已是 codebase 廣泛使用的 fallback
- 無 concurrency / queue fairness 變更
