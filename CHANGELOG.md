# Changelog

All notable changes to tachi-lens are documented in this file.

## [0.2.0-beta.1] - 2026-07-15

### Added

- Quota-aware Gemini scheduling with per-model quota isolation and persisted reservations.
- DeepSeek overflow when Gemini quota, cooldown, or availability prevents immediate translation.
- Bounded fairness between live chat and backlog translation work.
- Privacy-safe translation diagnostics in the popup.
- Improved support for Twitch channel, popout, VOD, clip, and SPA navigation flows.
- Per-channel settings, keyboard shortcuts, multilingual UI, and provider-specific error indicators.
- Support for Google Gemini, DeepSeek, OpenAI GPT, and Anthropic Claude providers.

### Changed

- Translation scheduling now coordinates concurrency, deadlines, cooldowns, retries, cache ordering, and quota settlement centrally.
- Provider errors retain their original provider, HTTP status, retry timing, and classification.
- Twitch DOM observation and message filtering are more resilient to current Twitch layouts and recycled nodes.

### Fixed

- Gemini quota failures can fall back to DeepSeek without losing retry timing.
- Directly selected DeepSeek requests preserve DeepSeek authentication, request, rate-limit, and status errors.
- Content Script lifecycle handling now shuts down safely after extension-context invalidation.
- Popup CSP and sizing issues that could produce a blank popup.

### Known limitations

- This is a beta release intended for real-world Chrome and Twitch validation.
- Packaged-extension E2E coverage is being completed separately before the stable `0.2.0` release.
- Unsafe legacy quota snapshots remain fail-closed until storage is repaired.
