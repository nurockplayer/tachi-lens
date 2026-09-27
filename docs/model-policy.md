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

## Discovery and promotion

`Provider Model Drift` runs daily and can be dispatched manually. Dedicated repository Actions secrets are `MODEL_MONITOR_GEMINI_API_KEY` and `MODEL_MONITOR_DEEPSEEK_API_KEY`; never use production user keys. The monitor uses [Gemini models.list](https://ai.google.dev/api/models) with bounded pagination and [DeepSeek models](https://api-docs.deepseek.com/api/list-models). It compares stable capability/version/deprecation metadata and model additions/removals with the previous catalog observation in a marked bot-owned issue. Gemini Flash/Pro families and DeepSeek models are the relevant set. Models may be repointed without an ID change; changes to API-exposed metadata are detected. Provider events not exposed through these APIs still require human attention to official deprecation notices; the detector does not claim to infer undisclosed future retirements.

No meaningful drift produces no issue update. Addition, replacement, retirement, lost capabilities, missing recommended/fallback models, approaching policy expiry or an operational failure produces actionable run-linked evidence. Missing secrets and failed API calls never become empty catalogs. Repeated unchanged failures do not produce repeated issue comments. The monitor cannot write repository contents or promote policy; new models remain candidates.

Promotion procedure:

1. Review official provider metadata and identify a candidate with the existing API/audio contract. Do not order models lexically or pick the highest version. Unsupported endpoints, audio formats, request options or response structures require a client change.
2. Edit only the appropriate model policy/configuration, compatible fallback list, revision and validity interval in a normal focused PR. Increase revision for every publication, including renewal/rollback. Keep compatible pins available where provider support remains.
3. Deterministic CI validates schema and runs the full request/response, settings, cache, fallback, quota, speech and privacy regressions plus packaged MV3 E2E. The initial reader PR is a runtime change (T2). JSON-only policy promotions are also T2 under the repository classifier.
4. `model-compatibility` detects changed policy JSON, records an authoritative catalog observation from the exact candidate, and makes credentialed requests against every remotely selectable model/configuration. It generates a synthetic English utterance using espeak/ffmpeg on the runner, then uses the actual chat and Gemini WAV/inlineData adapters. It checks translated IDs/nonempty output, nonempty speech transcript/translation and a 15-second request ceiling. Reports bind policy revision/hash and the PR head artifact name. No source payload/output or key is logged. Missing credentials or failed probes fail the gate; no auto-merge or automatic promotion occurs.
5. Review the live latency measurements for real-time suitability and inspect human translation quality, provider privacy/retention terms, deprecation notices and speech quality. A synthetic one-shot probe cannot prove sustained latency, account-specific quota suitability, semantic translation quality or provider privacy compliance. Record this disposition and fresh independent review on the exact PR head; merge only when all required gates pass. The existing human tabCapture canary remains separate; synthetic audio does not claim that evidence.

Local commands use the pinned package manager:

```sh
pnpm check:model-policy
pnpm models:discover
SPEECH_PROBE_WAV=/absolute/path/synthetic-16khz-mono.wav pnpm models:probe
```

The latter two require the dedicated keys in their environment. Reports are generated validation artifacts and must not be committed. The monitor workflow uploads reports and stores only privacy-safe catalog evidence in GitHub.

## Initial reader baseline

The initial policy preserves the model/configuration combinations released at `ddd7fec`: Gemini 3.8 Flash chat/speech uses low thinking, Gemini 2.5 Flash/Pro chat/speech uses the existing default configuration, and DeepSeek Flash/Pro chat disables thinking. Prompts, provider endpoints, authentication, audio encoding and response parsing carry forward their existing contracts. The reader, effective channel routing, policy fetch and diagnostics are new execution boundaries and require their own regression and privacy review. Earlier releases establish shipped behavior, not human semantic-quality certification. Fresh human semantic-quality requalification is not an additional requirement for this unchanged initial baseline; subsequent promotions changing it retain step 5. Credentialed compatibility/catalog evidence and observed latency disposition remain required. Provider account terms and retention handling carry forward without a claim of newly verified compliance.

## Rollback and release boundary

To reverse a bad recommendation, open a reviewed policy PR selecting a previously validated fallback, increment revision, renew validity and pass the compatibility/review gates. Merge updates the fixed remote URL; eligible Auto clients adopt at the next six-hour refresh, while pins remain stable. Offline clients continue their valid cache/bundle. Do not decrement revision or rely on a new extension release to roll back compatible model metadata.

A configuration-only change may add a validated safe model ID, change recommendations/fallbacks, select already implemented request options, or renew the policy. A new extension release is required for schema/reader changes, new provider/origin, API endpoint/auth changes, new request options, incompatible response parsing, audio/capture formats, quota semantics or privacy changes. Discovery alone never authorizes either route.
