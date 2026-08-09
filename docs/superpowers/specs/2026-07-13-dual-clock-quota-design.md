# Dual-Clock Gemini Quota Design

## Goal

Make Gemini quota accounting conservative under wall-clock rollback while using monotonic elapsed time for all in-process durations.

## Clock contract

`Clock` exposes two independent readings:

- `monotonicNow()` is used for scheduler deadlines, rolling RPM/TPM expiry, provider timeouts/waits, and cooldown elapsed time within one service-worker lifetime.
- `wallNow()` is used only for persisted restart state and validated `America/Los_Angeles` provider-day identity.

Production uses `performance.now()` for monotonic time and `Date.now()` for wall time. Tests inject a deterministic mutable clock.

## Persisted state

Quota storage version 3 adds a root `wallHighWaterMark` and a `clockTrusted` marker. The high-water value is the greatest trusted wall-clock observation durably committed by the quota store and never decreases. Reservations retain their wall-clock creation timestamp, and cooldowns retain a wall-clock deadline, because monotonic readings cannot survive a worker restart.

On restoration, the store converts each persisted reservation and cooldown into a remaining duration anchored at the new worker's monotonic reading. The conversion uses `max(currentWall, wallHighWaterMark)` as the trusted wall reference. If `currentWall < wallHighWaterMark`, the store enters clock-rollback mode, retains all state, and denies Gemini reservations with `clock_rollback`. For trusted snapshots, the denial clears when wall time catches up. Snapshots with `clockTrusted === false` remain fail-closed until explicitly repaired.

Version-2 migration derives a conservative high-water mark only when every bucket is structurally complete and at least one valid persisted reservation timestamp supplies a trusted observation. If the snapshot is incomplete or has no safe observation, `clockTrusted` remains false across the v3 rewrite and the state stays fail closed until it is explicitly repaired instead of silently becoming permissive after a timer or day transition.

## Runtime behavior

Within a worker, wall adjustments never alter monotonic reservation expiries, scheduler deadlines, or cooldown deadlines. Trusted wall time can advance no faster than monotonic elapsed time, so a forward wall jump cannot reset RPD before elapsed time proves the Pacific-day boundary was crossed. A backward wall observation activates fail-closed routing without pruning reservations, changing provider day, reducing RPD, or shortening cooldowns. DeepSeek remains available because the scheduler treats `clock_rollback` as a bounded quota denial with no future Gemini wake time.

When wall time catches up, the rollback latch clears only for trusted snapshots. Monotonic elapsed time may then safely prune in-process state. Untrusted snapshots remain fail-closed until explicitly repaired; the current implementation provides no automatic repair mechanism. For trusted snapshots, the updated state and nondecreasing high-water mark are persisted.

## Provider day

Provider-day strings must pass real Gregorian `YYYY-MM-DD` validation before comparison. RPD resets only if the current valid Pacific date is lexically later than the stored valid date and the wall clock is not behind its trusted high-water mark. Earlier, invalid, or ambiguous dates retain the existing provider day and count.

## Forward wall jumps across worker restart (accepted residual risk)

Issue #64 evaluated whether suspicious forward/backward wall-clock jumps can be detected or conservatively bounded across MV3 Service Worker restarts. The conclusion: reliable **local** detection of a forward jump first observed after restart is not achievable at reasonable cost without unacceptable false positives. Legitimate downtime is unbounded (overnight shutdown, vacation), best-effort shutdown markers are unreliable on crash/reboot/update, Chrome exposes no authoritative previous-session-end instant, and the manifest declares only the `storage` permission (no alarms). Every candidate mechanism either denies a valid returning user (false positive) or leaves an attacker-detectable bypass. The accepted policy keeps the current behavior unchanged and documents the residual risk below.

### Behavior today

Within one worker context, trusted wall time advances no faster than monotonic elapsed time, so a forward wall jump cannot reset RPD or shorten rolling/cooldown deadlines before monotonic elapsed time proves the transition. Across a worker restart the previous monotonic epoch is gone, and the first observation in the new context adopts `max(currentWall, wallHighWaterMark)` as the trusted wall reference. A forward wall jump first observed after restart is therefore indistinguishable from legitimate downtime. Because restoration anchors rolling expiries, cooldowns, and the provider day to that trusted wall, an accepted forward jump may expire rolling/cooldown state and cross a Pacific provider day (resetting that bucket's daily count) before any monotonic elapsed time exists to corroborate the transition.

### Threat model

| Axis | Jump | Evidence available | Handling |
| --- | --- | --- | --- |
| Same worker context | Forward | Trusted wall clamped by monotonic elapsed time | Handled by #47: no premature RPD reset or rolling/cooldown advance. |
| Same worker context | Backward | Raw wall below the persisted high-water mark | Handled by #47: `clock_rollback` fail-closed, usage retained. |
| Across worker restart | Backward | Persisted high-water mark survives | Handled by #47: `clock_rollback` fail-closed (regression test covers restart behind high-water). |
| Across worker restart | Forward | First wall observation adopted; no monotonic epoch survives | Ambiguous gap — subject of #64. |

Lifecycle cases: a short MV3 idle termination already loses the monotonic epoch, so even a small gap is unverifiable. Sleep retains protection only while the same worker context survives; once terminated it is indistinguishable from shutdown. Normal shutdown, browser/extension update, crash, and OS reboot all present as restarts with no trustworthy previous-session-end evidence. Long downtime or vacation is semantically identical to a large forward jump based on persisted local evidence alone.

Abuse: an attacker able to change the system clock can terminate or wait for the worker to terminate, advance the clock across a Pacific provider-day boundary, and cause the next reservation to reset the affected model bucket's daily count. Impact is bounded by provider-side rate limits, daily limits, billing controls, and account caps, and a backward return trips the persisted high-water rollback protection.

### Candidate comparison

| Candidate | Evidence available | Security benefit | False positives / false negatives | Persistence, privacy, MV3 reliability | Cost and verdict |
| --- | --- | --- | --- | --- | --- |
| 1. Lifecycle/shutdown markers | Last successfully written marker, clean suspend/start transitions | Can explain some restarts when every event is recorded | FP: marker absent after crash/kill/reboot/update/failed write misclassifies normal behavior. FN: attacker induces an unmarked termination or reuses a normal-looking marker. | Adds persisted lifecycle state and writes; `onSuspend` is not dependable enough to be a security boundary. Marker absence has no safe meaning. | Moderate cost, low assurance. Rejected for enforcement. |
| 2. Conservative maximum elapsed-time bound | Persisted wall high-water vs first post-restart wall | Rejects forward jumps larger than a threshold | FP: every legitimate downtime longer than the threshold denies a returning user. FN: attacker stays under the threshold or repeats smaller transitions. | Simple persistence, no new privacy exposure; no independent elapsed-time evidence exists. | Cheap but fundamentally unsound. Rejected. |
| 3. Chrome alarms / session metadata | Alarm history while Chrome runs | May narrow gaps only while the browser is continuously active | FP: delayed/coalesced/missed alarms and browser suspension. FN: browser shutdown removes coverage; alarm timestamps are still wall-derived. | Requires the `alarms` permission (manifest has only `storage`); persistence across browser sessions does not make timestamps authoritative. No previous-session-end instant is exposed. | High lifecycle/test complexity for incomplete coverage. Rejected as a security mechanism. |
| 4. Provider-day transitions | Persisted provider day vs first post-restart wall-derived day | Could retain old RPD when a transition lacks continuous monotonic proof | FP: ordinary overnight shutdown/update/vacation denies a valid new day; waiting a full monotonic day after every restart harms normal users (MV3 workers restart frequently). FN: any downtime exception restores the bypass. | No external privacy cost, but changes quota semantics or requires restart provenance. | Strongly conservative but violates the no-permanent-false-denial invariant. Rejected. |
| 5. Diagnostics-only uncertain forward jump | First hydration raw wall above persisted high-water; whether a persisted provider day was crossed | No prevention; can surface that continuous monotonic evidence was unavailable | No quota FP if informational only, but the signal is semantically ambiguous (normal downtime produces the same condition) and offers no user corrective action. | Runtime-only possible; privacy-safe if it carries only a delta/category and no chat, user, or key data. | Low-to-moderate cost; noisy and unactionable. Not implemented by default. |
| 6. External time source | Independent authenticated server time | Only candidate that can distinguish an incorrect local wall from authoritative current time | FP: stale/bad intermediary disagreement. FN: source unavailable, header absent, captive portal, or validation after admission. | Adds availability and trust dependencies; a dedicated request creates privacy/traffic concerns and is forbidden without a separate design/privacy review. Provider response time arrives too late for initial admission. | Potentially strong but disproportionate to the bounded harm. Not pursued. |
| 7. Documented residual risk | Explicitly records that post-restart forward elapsed time is unprovable locally | Avoids pretending a heuristic is a security control; preserves robust existing behavior | Known FN: post-restart forward manipulation is accepted. No new false denial. | No new data, permission, storage, or lifecycle dependency. | Lowest cost, most maintainable. Selected. |

### Accepted policy

- Backward jumps remain fail-closed across restarts via the persisted high-water mark; valid RPD/RPM/TPM usage is retained during rollback and never discarded merely because the clock moved.
- A forward wall value first observed after restart is accepted, because local evidence cannot distinguish it from legitimate downtime. Rolling/cooldown expiry and provider-day rollover that follow from that accepted wall are documented consequences of the accepted gap, not a corruption-detection reset.
- DeepSeek overflow remains available whenever Gemini is denied.
- No lifecycle marker, alarm, elapsed-time bound, or provider-day heuristic becomes an enforcement input, and no external request is added solely to validate time.

### Residual risk

An attacker who can change the system clock can terminate or wait for the worker to terminate, advance the clock across a Pacific provider-day boundary, and cause the next reservation to reset the affected model bucket's daily count. Quota accounting is per model (`quotaKey`), so each configured Gemini model bucket can be reset independently by repeated accepted forward transitions. The enlarged extension-side capacity remains bounded by provider-side rate limits, daily limits, billing controls, and account caps, and a backward return triggers the persisted high-water rollback protection. No false-positive denial of legitimate users is introduced. External authoritative time could remove the ambiguity but adds a dependency and privacy/availability trade-off disproportionate to this bounded harm, so it is intentionally not pursued.

## Tests

Store tests cover backward wall movement with full RPM/TPM, Pacific-date rollback across PDT and PST, restart behind the high-water mark, cooldown retention, recovery, high-water monotonicity, and version-2 migration. Scheduler/Translator tests use the real `Translator -> QuotaScheduler -> GeminiQuotaStore -> Provider` path to verify `clock_rollback` overflow, no Gemini dispatch while fail closed, DeepSeek availability, and monotonic live deadlines despite wall adjustment.
