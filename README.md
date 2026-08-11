# tachi-lens

Twitch chat immersive translation Chrome Extension, supporting Google Gemini, DeepSeek, OpenAI GPT, and Anthropic Claude APIs.

**Language policy:** English is the canonical language for all technical artifacts in this repository (code, comments, tests, logs, and documentation). User-facing copy, localization resources, and language-sensitive test fixtures remain in their original languages.

## Features

- Translates Twitch chat messages in real time
- Three display modes (all preserving the original text): appended below the original / Hover to show / collapsed original
- Supports four LLM providers, with provider and model switchable freely in the Popup
- Bring-Your-Own-Key (BYOK); keys are stored locally only
- Batch translation + caching to avoid frequent API calls

## Supported providers and models

| Provider | Supported models | Default model |
| --- | --- | --- |
| Google Gemini | Gemini 2.5 Flash, Gemini 2.5 Pro | Gemini 2.5 Flash |
| DeepSeek | DeepSeek V4 Flash, DeepSeek V4 Pro | DeepSeek V4 Flash |
| OpenAI GPT | GPT-4o mini, GPT-4o | GPT-4o mini |
| Anthropic Claude | Claude 3.5 Haiku, Claude 3.5 Sonnet | Claude 3.5 Haiku |

## Tech stack

- TypeScript + Vite + pnpm
- Chrome Extension Manifest V3
- React (Popup only)
- Content Script in plain TS, lightweight injection into the Twitch DOM

## Development

```bash
pnpm install
pnpm dev        # development mode
pnpm build      # production build
```

## E2E tests

Uses Playwright with a bundled Chromium (`channel: 'chromium'`) to actually load the built Chrome Extension and verify that the MV3 Service Worker starts correctly.

```bash
pnpm exec playwright install chromium  # required on first run to install the browser
pnpm test:e2e                           # builds the extension and runs E2E
```

Tests run in headless mode; no display or Xvfb is needed. The test run creates a temporary user data directory that is cleaned up automatically on exit.

### Live Twitch DOM compatibility canary

An additional **non-deterministic** canary test that actually loads the currently packaged extension, connects to a real Twitch channel page, and verifies the Content Script attaches and recognizes real chat messages.

```bash
TWITCH_CANARY_URL='https://www.twitch.tv/<known-active-channel>' pnpm test:e2e:canary
```

Related settings:

- `TWITCH_CANARY_URL` (required): full Twitch channel URL, e.g. `https://www.twitch.tv/informalmiku_`
- This test **does not** call any translation provider and does not use an API key
- The default `pnpm test:e2e` **does not include** this canary
- Runs in CI on a daily schedule plus manual triggers, and does not block pull requests

## Architecture

```
src/
  background/     # Service Worker — API calls, batch queue, caching
  content/        # Content Script — MutationObserver, DOM injection
  popup/          # React Popup — settings UI, provider switching
  providers/      # TranslationProvider interface + Gemini/DeepSeek/OpenAI/Claude adapters
  storage/        # chrome.storage wrapper
  shared/         # shared types, message protocol, cache utilities
```

## License

MIT
