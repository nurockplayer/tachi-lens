# Provider model policy

Issue #200 freezes the migration and security contract inline. This runbook explains its operation; it does not broaden that issue. Gemini chat, Gemini speech and DeepSeek chat use schema 1. OpenAI and Claude continue using their packaged configuration.

## Reader and trust boundary

An initial extension update is required to install the policy reader and its GitHub host permission. An older build without the reader never consumes policy data. The initial reader ships in v0.3.3 through the existing merge-triggered GitHub Release/ZIP workflow; schema 1 requires client v0.3.3 or later. Chrome Web Store publication remains separate. Once the reader is installed, a compatible model recommendation can change independently of an extension build.

Only the service worker fetches `https://raw.githubusercontent.com/nurockplayer/tachi-lens/main/public/model-policy.json`. GitHub repository write access, reviewed PRs, merge disposition and HTTPS are the publication trust boundary. The manifest contains data, never code, request URLs, headers, prompts, quota overrides or expressions. Redirects, unknown fields, providers/workloads/options, unsafe model IDs, incompatible schema/client versions and invalid dates are rejected. IDs are constrained to the Gemini/DeepSeek families; a discovered identifier is not automatically trusted. Supported configurations are `default`, `gemini-low-thinking` and `deepseek-disabled-thinking`; the client owns their request semantics.

Chrome requires cross-origin host permission for the service-worker fetch. `https://raw.githubusercontent.com/*` is the only new origin; Chrome ignores path components in host permissions, so the runtime additionally fixes the exact repository URL. The default extension CSP remains intact. Remote JSON is not interpreted or executed. See [Chrome network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) and [Manifest V3 store requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements). No claim of store approval is made.

## Selection and migration

`auto` means Auto / Recommended. Missing/new Gemini/DeepSeek chat selections and missing speech selections use Auto. Every saved nonempty concrete global, channel or speech model remains a pin, even when it equals the previous default: historical storage cannot distinguish an explicit default from an implicit one. The existing `deepseek-v4-flash` alias normalization remains intact. Other providers are unaffected. DeepSeek key checks validate authentication and catalog shape independently of the packaged default; a retired model remains an availability/translation error rather than an invalid credential.

The popup shows Auto, known compatible models and any saved pin. Changing recommendations never rewrites a pin. A pin outside the current policy retains the bundled/legacy request configuration; a provider rejection uses the existing actionable error contract. The user must deliberately choose Auto or another model to abandon a retired pin. No error silently migrates that selection.

Chat batches stay within one channel settings/cancellation domain, using its effective global-plus-channel selection. One policy snapshot supplies the chat primary and DeepSeek fallback models before cache identity and Gemini quota admission. Quota buckets use actual model IDs; quota limits remain user-owned. Speech uses a separate recommendation and fixes its model/options at session start; restarting speech adopts a later promotion. Existing consent, capture, budget and shutdown semantics stay unchanged. Gemini→DeepSeek fallback triggers and retry/cooldown contracts remain unchanged. Manifest `fallbacks` identify validated rollback candidates; the client does not add same-provider retries or extra request cost.

## Offline behavior, bounds and diagnostics

Resolution uses valid remote state, revalidated cached last-known-good state, then the immutable packaged policy. Remote/cache data must be compatible and unexpired. Packaged data does not expire offline. A remote body is limited to 32 KiB, fetch plus body reading to three seconds, and refresh/failure backoff to six hours across worker restarts. Concurrent consumers share one fetch. Storage failures keep an in-memory throttle and snapshot. Older revisions cannot replace a valid newer cache; rollback therefore always publishes a new revision. Validity intervals are at most 30 days; renew the policy before expiry even without a model change.

The popup Diagnostics section shows policy source/schema/revision and up to three recent resolutions from a bounded 20-entry service-worker buffer. Records contain only provider, workload, resolved model/configuration, Auto/pinned mode, source, revision and timestamp. They describe resolution (including prepared fallback/cache-hit resolution), not proof that a provider call occurred. Unknown user-entered pin strings never enter the buffer. Full keys, original chat, usernames, audio, translations, provider bodies and raw errors are excluded. The policy snapshot request accepts only the packaged popup sender.

## Discovery, qualification and promotion

`Provider Model Drift` runs daily and can be dispatched manually. Discovery requires **no provider credentials**. It observes fixed official public technical [Gemini model](https://ai.google.dev/gemini-api/docs/models?hl=en), [deprecation](https://ai.google.dev/gemini-api/docs/deprecations?hl=en) and [release-note](https://ai.google.dev/gemini-api/docs/changelog?hl=en) documents, plus [DeepSeek API models](https://api-docs.deepseek.com/) and [changelog](https://api-docs.deepseek.com/updates/). Requests omit credentials, reject redirects and bound response size/time. The parser checks expected document titles, article structures and model/lifecycle tables or operational release statements; unrecognized or empty content is an operational failure, not an empty catalog.

Normalized model/lifecycle observations and source fingerprints are compared with the prior observation in a marked bot-owned issue. Page chrome, ordering, benchmark and pricing-only changes are excluded. No meaningful drift produces no update; changed model/lifecycle statements, missing documented recommendations/fallbacks, approaching policy expiry, or operational failure produce bounded run-linked evidence. Repeated unchanged failures are deduplicated. Source layout changes require an explicit parser repair rather than silent success. The detector cannot write repository contents or promote policy.

Public documentation is authoritative for published identifiers and announced lifecycle changes, **not account-specific callable availability, successful translation, audio support or latency**. A missing listing is reported as `not-documented`, never inferred API retirement. Undisclosed provider changes remain outside public discovery. Newly documented models are candidates only; do not select by lexical/version ordering.

The four boundaries are separate: discovery proposes candidates; deterministic/static validation verifies the packaged request/response and runtime contract; credentialed qualification tests actual provider behavior; a reviewed policy PR governs production promotion.

Promotion procedure:

1. Review official provider evidence and identify a candidate compatible with the existing API/audio contract. Unsupported endpoints, audio formats, options or response structures require client engineering.
2. Edit the appropriate policy/configuration, compatible fallback list, revision and validity interval in a focused PR. Every publication, renewal and rollback increases revision. Preserve compatible explicit pins.
3. Deterministic CI validates schema and runs full request/response, settings, cache, fallback, quota, speech and privacy regressions plus packaged MV3 E2E. Initial reader and JSON-only policy changes are T2.
4. `model-compatibility` compares the candidate to the **exact PR base**, observes public provider metadata, and uploads the qualification classification and discovery report. A one-time exact baseline bootstrap or revision/date-only renewal with identical effective policy does not require fresh provider calls. Every recommendation/fallback/model/configuration/workload change, including a switch or rollback among previously listed tuples, requires credentialed actual-adapter probes. Unknown/malformed comparisons fail closed; absence of a base file alone grants no exemption.
5. Required probes use dedicated Actions secrets `MODEL_MONITOR_GEMINI_API_KEY` and `MODEL_MONITOR_DEEPSEEK_API_KEY`, never production user keys. They cover every selectable tuple with synthetic chat/audio through actual adapters: translated IDs/nonempty output, speech transcript/translation, supported request options and measured request latency. Missing credentials or failed probes block promotion. Reports bind policy revision/hash and exact-head job/artifact provenance. No source payload/output or key is logged; a skipped probe is explicitly not live qualification.
6. Before promotion, disposition actual measured latency for real-time suitability and applicable human translation/speech quality, provider privacy/retention terms and deprecation evidence. A 15-second ceiling or one-shot result does not prove sustained/capture-to-caption latency, account quota suitability, semantic quality or privacy compliance. Record the disposition and fresh exact-head independent review; merge only when applicable gates pass. The historical human tabCapture canary remains separate.

Local commands use the pinned package manager:

```sh
pnpm check:model-policy
pnpm models:discover
SPEECH_PROBE_WAV=/absolute/path/synthetic-16khz-mono.wav pnpm models:probe
```

Only `models:probe` needs dedicated credentials. Generated reports are artifacts, never committed. Routine drift observation has no provider billing/key-maintenance dependency; provider qualification still needs credentials when promotion changes production selection.

## Initial reader baseline

The initial policy preserves exactly the eight model/configuration tuples and recommendations released at `ddd7fec501d63cbd995329e3be91e577b39d01cb`: Gemini 3.8 Flash chat/speech uses low thinking, Gemini 2.5 Flash/Pro chat/speech uses default configuration, and DeepSeek Flash/Pro chat disables thinking. Fallback eligibility is confined to those existing combinations, without another automatic retry. The bootstrap classifier binds that exact base SHA and a frozen effective-policy fingerprint; it does not trust a candidate declaration. A different base or policy behavior requires qualification.

Side-by-side execution of the actual released-main and candidate adapters proves identical serialized endpoints, authentication, prompts, thinking configuration and WAV audio, plus identical success/malformed/empty/rate-limit/authentication response handling for all eight tuples. These are synthetic deterministic comparisons, not real provider calls. Full deterministic/runtime/privacy regression and successful public discovery remain initial-reader gates.

New reader, effective channel routing, policy fetch/cache and diagnostics boundaries retain their regression and independent review obligations. The unchanged request contract creates no new provider latency or semantic behavior to requalify: fresh credentialed provider compatibility/latency and human semantic qualification are narrowly **N/A for this initial preserved baseline**, not reported as passed. Earlier shipment establishes continuity, not live/human certification. Future effective-policy promotions retain all applicable qualification/disposition gates above. Existing account-specific restrictions and provider retention handling carry forward without newly verified compliance claims.

## Rollback and release boundary

To reverse a bad recommendation, open a reviewed policy PR selecting a previously validated fallback, increment revision, renew validity and pass the compatibility/review gates. Merge updates the fixed remote URL; eligible Auto clients adopt at the next six-hour refresh, while pins remain stable. Offline clients continue their valid cache/bundle. Do not decrement revision or rely on a new extension release to roll back compatible model metadata.

A configuration-only change may add a validated safe model ID, change recommendations/fallbacks, select already implemented request options, or renew the policy. A new extension release is required for schema/reader changes, new provider/origin, API endpoint/auth changes, new request options, incompatible response parsing, audio/capture formats, quota semantics or privacy changes. Discovery alone never authorizes either route.
