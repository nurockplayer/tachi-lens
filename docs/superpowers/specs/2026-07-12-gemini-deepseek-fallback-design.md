# Gemini 429 Recovery and DeepSeek V4 Flash Fallback

## Goal

Keep Gemini as the configured primary provider, correctly expose and respect its API errors, and automatically translate through DeepSeek V4 Flash when Gemini returns HTTP 429 and a DeepSeek API key is configured.

## Chosen behavior

- The selected provider remains the primary provider.
- Automatic fallback applies only when the selected provider is Gemini and Gemini returns HTTP 429, or Gemini is still inside a cooldown created by a previous HTTP 429.
- The fallback provider is always `deepseek` with model `deepseek-v4-flash`.
- Fallback is attempted only when a DeepSeek API key exists.
- Authentication failures, malformed requests, unsupported models, network failures, timeouts, and Gemini 5xx responses do not trigger DeepSeek fallback.
- If DeepSeek fallback fails, the user receives the DeepSeek failure when an API call was attempted; if no DeepSeek key exists, the original Gemini 429 is returned with a clear fallback-unavailable explanation.
- No API key or raw provider response body is written to logs or diagnostics; only a bounded, sanitized error message is retained.

## Provider result contract

`BatchItemResult` keeps its existing string `error` for compatibility and gains structured metadata:

- `status?: number` — HTTP status returned by the provider.
- `retryAfterMs?: number` — provider-directed retry delay when available.

Provider adapters must parse safe error details from their response bodies and retain the HTTP status. Gemini should read `error.message` and `google.rpc.RetryInfo.retryDelay`; both Gemini and DeepSeek should honor a valid `Retry-After` header. Invalid or unreadable error bodies fall back to a provider-and-status message.

The translator uses structured `status === 429` as the fallback trigger. Legacy text matching remains only as a compatibility classifier for adapters that have not yet adopted structured metadata; it must never initiate Gemini-to-DeepSeek automatic fallback.

## Translation flow

1. Read settings and the primary provider key.
2. Check the cache under the primary provider/model key.
3. If Gemini is in a recorded 429 cooldown, skip the Gemini request and try DeepSeek fallback immediately.
4. Otherwise call Gemini normally.
5. On Gemini HTTP 429, record its provider-supplied retry delay, then try DeepSeek V4 Flash.
6. DeepSeek fallback uses the same batch, target language, and source-language hints.
7. Cache successful results under the provider and model that actually produced them.
8. While Gemini remains in cooldown, fallback requests check the DeepSeek cache before calling the DeepSeek API.
9. A successful Gemini call resets only Gemini's limiter; a successful DeepSeek call resets only DeepSeek's limiter.

This keeps provider rate-limit state independent and avoids repeatedly calling Gemini while its cooldown is active.

## DeepSeek V4 Flash support

The popup continues to expose DeepSeek as a normal selectable provider with its own API key. The registry must expose `deepseek-v4-flash`, and the adapter must send that exact model ID to `https://api.deepseek.com/chat/completions`.

Because translation does not need chain-of-thought reasoning, requests explicitly set DeepSeek V4's thinking mode to disabled. Key validation must confirm that `/models` succeeds and that `deepseek-v4-flash` is present in the returned model list.

## Diagnostics and retry behavior

- Gemini 429 diagnostics show the sanitized API message and effective retry delay instead of the current generic sentence.
- Successful fallback records that DeepSeek V4 Flash produced the translation.
- The existing global cooldown remains the authority for suppressing repeated Gemini calls.
- Content-script retries honor the returned cooldown. Diagnostics for one failed batch are summarized so a ten-message batch does not appear as ten independent provider failures.

## Tests

The implementation follows red-green-refactor cycles for these behaviors:

1. Gemini preserves HTTP 429 message, status, and retry delay.
2. Gemini 403 and malformed error bodies remain non-fallback errors.
3. A Gemini 429 calls DeepSeek V4 Flash and returns its translation.
4. An open Gemini cooldown routes directly to DeepSeek without another Gemini call.
5. Missing DeepSeek credentials return an actionable Gemini rate-limit result.
6. Gemini non-429 failures never call DeepSeek.
7. DeepSeek sends `deepseek-v4-flash` with thinking disabled and validates model availability.
8. Fallback results are cached under DeepSeek V4 Flash and reused during Gemini cooldown.
9. Popup/provider tests prove DeepSeek V4 Flash is selectable and persisted.
10. Batch diagnostics do not emit one duplicate rate-limit entry per message.

Run the full Vitest suite, TypeScript checking, production build, and a Chrome test on a live Twitch chat. Chrome verification must confirm both a normal Gemini path when available and a forced/mockable 429-to-DeepSeek path without exposing either API key.

## Out of scope

- Falling back from providers other than Gemini.
- Falling back on errors other than HTTP 429.
- Provider priority lists or user-configurable fallback chains.
- Migrating the project to a provider SDK.
- Changing API-key storage or security boundaries.
