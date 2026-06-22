# Privacy Policy for tachi-lens

Last updated: June 22, 2026

## Overview

tachi-lens is a Chrome Extension that provides immersive translation for Twitch chat. The extension runs in the user's browser and uses a bring-your-own-key model: users choose a translation API provider and provide their own API key.

tachi-lens does not operate a backend server. The extension does not include analytics, advertising trackers, behavioral tracking, or telemetry.

## Data Collection and Processing

tachi-lens may process the following data to provide translation features:

- Twitch chat message text visible on Twitch pages where the extension is active.
- Translation settings, such as selected provider, target language, display mode, and related preferences.
- Provider API keys entered by the user.
- Local translation cache or batching metadata used to reduce repeated API calls.

Twitch chat may contain personal information if a chat participant posts it. tachi-lens processes chat text only for translation.

## How Data Is Used

tachi-lens uses data only to:

- Detect Twitch chat messages on supported Twitch pages.
- Send chat text to the translation API provider selected by the user.
- Display translated text in the Twitch chat UI.
- Store local settings and API keys.
- Cache or batch translations locally to reduce duplicate requests.

## Translation API Providers

When translation is enabled, Twitch chat text is sent from the extension to the API provider selected and configured by the user. Supported providers include Gemini, DeepSeek, OpenAI, and Anthropic Claude.

The selected provider's own terms, privacy policy, retention policy, billing rules, rate limits, and data handling practices apply to those requests.

tachi-lens does not proxy translation requests through a tachi-lens server.

## API Key Storage and BYOK Responsibility

API keys are stored only in `chrome.storage.local` in the user's Chrome profile. They are not uploaded to a tachi-lens backend server because tachi-lens does not operate one.

In BYOK mode:

- The user is responsible for obtaining, managing, rotating, and revoking API keys.
- The user is responsible for provider usage, billing, quota consumption, and rate limits.
- The extension uses the API key only to make translation requests to the selected provider.
- tachi-lens cannot recover a lost API key.
- If the user's browser profile, device, or sync environment is compromised, locally stored extension data may be exposed according to Chrome and device security behavior.

Users should create restricted provider keys where possible, monitor usage, and revoke keys that are no longer needed.

## Data Sharing

tachi-lens does not sell user data.

tachi-lens does not share data with advertisers, analytics services, tracking networks, or a tachi-lens backend.

The only external data transfer required for translation is the request sent to the user-selected API provider. This request may include chat text to be translated and the user's API key for authentication.

## Data Storage and Retention

The extension stores settings and API keys locally in Chrome extension storage. Translation cache data, if present, is stored locally and used to avoid repeated translation of the same content.

Users can delete stored data by:

- Removing or updating API keys and settings in the extension popup.
- Clearing the extension's storage through Chrome settings.
- Uninstalling the extension.

Because tachi-lens does not operate a backend server, it does not retain server-side copies of chat text, API keys, settings, or translation history.

## Permissions

tachi-lens may request Chrome permissions needed to:

- Run on supported Twitch pages.
- Observe and modify the Twitch chat UI to display translations.
- Store user settings and API keys locally.
- Communicate between the content script, service worker, popup, and configured translation providers.

Permissions are used only for the extension's translation functionality.

## Security

tachi-lens is designed to keep provider API keys local to the user's browser profile and to send translation requests directly to the selected provider over HTTPS.

No browser extension can guarantee complete protection against device compromise, malicious software, browser profile compromise, or provider-side incidents. Users should protect their device and Chrome profile, use restricted API keys where possible, and revoke keys if misuse is suspected.

## User Rights and Choices

Users may:

- Disable translation.
- Change the selected provider.
- Update or remove API keys.
- Clear local extension data.
- Uninstall the extension at any time.
- Contact the extension developer with privacy questions through the support or contact information listed in the Chrome Web Store listing for tachi-lens.

## Children's Privacy

tachi-lens is not directed to children and does not knowingly collect personal information from children. The extension processes Twitch chat text only to provide translation features selected by the user.

## Changes to This Policy

This policy may be updated when the extension's data handling, provider support, storage behavior, or Chrome permissions change. The updated policy will be published with a new "Last updated" date.

## Contact

For privacy questions, contact the extension developer through the support or contact information listed in the Chrome Web Store listing for tachi-lens.
