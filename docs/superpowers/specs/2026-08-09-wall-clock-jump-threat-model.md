# Wall-Clock Jump Threat Model and Mechanism Comparison

## Purpose

Research deliverable for issue #64: determine whether suspicious forward/backward wall-clock jumps can be detected or conservatively bounded across Manifest V3 Service Worker restarts without creating harmful false positives after normal browser downtime.

This document is **research only**. It changes no production behavior. Its conclusion is that retaining the current behavior as a documented residual risk is the only maintainably safe policy.

## Conclusion

No automatic cross-restart forward-jump detector is maintainably safe under MV3. A legitimate overnight shutdown and an attacker who advances the system clock while the worker is dead produce the same observable state. Retain this as a documented residual risk; do not add a quota-enforcement mechanism from this research.

The current design is appropriately fail-closed for backward movement and in-process forward movement. Its intentional trade-off is that a forward jump first seen after restart can prematurely expire rolling reservations/cooldowns and roll RPD forward.

## Clock contract (as built)

`Clock` exposes two independent readings (`src/background/clock.ts`):

- `monotonicNow()` — `performance.now()` — for scheduler deadlines, rolling RPM/TPM expiry, provider timeouts/waits, and cooldown elapsed time within one service-worker lifetime.
- `wallNow()` — `Date.now()` — for persisted restart state and validated `America/Los_Angeles` provider-day identity.

Production uses the system clock. Tests inject a deterministic mutable clock.

## 1. Threat model

An adversary may:

- Change the device clock forward to restore Gemini RPM/TPM, cooldown, or RPD capacity, then let/restart the MV3 worker.
- Change it backward to manipulate state after a forward jump.
- Cause ordinary-looking restarts through browser shutdown, update, crash, or idle worker eviction.
- Trigger legitimate clock corrections: NTP changes, manually corrected time zone/date, sleep/wake drift.
- Have extension-storage write access without the API key. This is a stronger, largely separate threat: storage tampering can alter usage state directly, so clock logic cannot make such storage trustworthy.

The attacker need not learn the API key to benefit if they can induce the extension to spend capacity using its configured credentials.

Current protections are sound within their boundary:

- `observeClock()` advances trusted wall time by no more than observed monotonic elapsed time and retains a monotonic high-water mark. A same-worker forward jump therefore cannot immediately clear rolling state or cross a Pacific day boundary. (`src/background/gemini-quota.ts:896`)
- A raw wall time below the high-water mark, or behind a persisted provider day, denies Gemini with `clock_rollback`; no pruning, cooldown expiry, or day reset occurs. (`src/background/gemini-quota.ts:325`)
- Denial routes work to DeepSeek rather than becoming a terminal translation failure. (`src/background/quota-scheduler.ts:202`)
- Restart restoration deliberately derives rolling/cooldown remaining duration from persisted wall timestamps. (`src/background/gemini-quota.ts:201`)

Unprotected case: after a restart, `initializeRuntimeClock()` has no predecessor monotonic epoch and initializes trusted wall time to `max(highWaterMark, rawWallNow)`. A forward raw wall observation is accepted as elapsed downtime. (`src/background/gemini-quota.ts:923`) It can therefore expire valid 60-second reservations/cooldowns and reset RPD when the claimed Pacific date is later.

Forward-then-backward is self-limiting but not reversible: the forward restart may already have restored capacity and allowed usage; the later backward observation fail-closes, but cannot restore quota already spent.

## 2. Observability

| Decision point | Observable evidence |
|---|---|
| Same worker lifetime | Consecutive wall readings, `performance.now()` elapsed, trusted wall/high-water mark, current Pacific day, in-memory cooldown/reservation deadlines. |
| Restart within browser session | Persisted local snapshot; best-effort `storage.session` mirror if it survived; current raw wall time. No prior monotonic epoch. |
| Browser restart / long shutdown | Only persisted local snapshot and current raw wall time. `storage.session` is gone. |
| Fundamentally unobservable | Whether elapsed wall time was legitimate downtime or an intentional forward clock change while no worker ran; true elapsed duration from a clock independent of the system wall clock. |

`chrome.storage.session` is in-memory and clears on browser restart, while `storage.local` persists. MV3 workers are expected to terminate and lose globals, so no lifecycle inference can depend on them.

## 3. Scenario matrix

| Situation | Forward wall movement | Backward wall movement |
|---|---|---|
| Same worker lifetime | Trusted wall progresses at most by measured monotonic elapsed. No instant RPM/TPM/cooldown expiry or RPD reset from the jump. | `clock_rollback`; Gemini state is not pruned/reset; DeepSeek remains available. |
| Worker restart | **Gap:** current raw wall is accepted. Persisted rolling state/cooldown can expire and later Pacific day can zero RPD. | Raw wall below persisted high-water marks rollback and fails closed until recovery/manual repair. |
| Sleep, worker survives | Identical to same-worker behavior, based on whatever monotonic elapsed the runtime reports after wake. No special sleep exception exists. | Same-worker rollback behavior. |
| Sleep, worker dies | Indistinguishable from an ordinary worker restart. | Indistinguishable from an ordinary worker restart. |
| Browser shutdown / long downtime | Correct ordinary case requires accepting elapsed time: minute quotas/cooldowns should expire and a later Pacific day should reset RPD. It is indistinguishable from abuse. | A user whose clock is now behind the high-water mark is denied Gemini until catch-up or explicit repair. |
| Browser/extension update | Local snapshot persists, worker state does not; therefore identical to cross-restart gap. | Same fail-closed rollback behavior. |

Diagnostics correctly expose rollback recovery without mutating state. (`src/background/quota-health.ts:156`)

## 4. Candidate comparison

| Mechanism | Evidence / benefit | False positives / negatives | Privacy, MV3 reliability, cost | Verdict |
|---|---|---|---|---|
| Persisted shutdown markers | A clean marker or session record may hint at shutdown type. It does not measure elapsed time or prove a forward jump. | Treating absent/unclosed as suspicious harms normal crashes, updates, evictions, and shutdowns. Accepting it leaves the attacker path intact. | Local metadata only, but `onSuspend` is not a reliable commit point and async cleanup is not guaranteed. Session data disappears at browser restart. Medium cost, weak tests. | Reject for enforcement. At most a non-security diagnostic hint. |
| Maximum elapsed-time cap | Limits how far trusted wall can advance per restart. | Any cap below real downtime misclassifies normal overnight/holiday use, delaying daily reset or causing denial. Any cap large enough for normal downtime is bypassable; repeated restarts can worsen this unless separately constrained. | No network/privacy cost; reliable to execute but not semantically reliable. High behavioral/test cost. | Reject. Violates the no-harm normal-downtime invariant. |
| Chrome alarms / browser-session metadata | Alarms can indicate scheduled work, and session presence distinguishes some same-browser restarts. Neither supplies an independent elapsed-time anchor: scheduled time is epoch wall time and alarms may be arbitrarily delayed. | Missed alarms are normal during sleep; absent alarms/session are normal after update/restart. Thus both enforcement and inference have large false-negative or false-positive sets. | Requires `alarms` permission and lifecycle handling. Persistent alarms have version/browser caveats; alarms do not wake sleeping devices and delayed alarms coalesce. | Reject for detection/enforcement. |
| Gate provider-day reset on monotonic proof | Strongly protects a running worker; this is already the effective current behavior. | Across restart there is no proof. Always requiring proof denies ordinary next-day startup; allowing reset based on wall preserves the current gap. It protects only RPD, not rolling reservations/cooldowns. | No new privacy cost; high contract complexity and extensive boundary tests. | Reject across restarts. Keep existing in-process rule. |
| Diagnostics-only uncertain-forward report | Can report "wall advanced since last durable observation," not "suspicious jump." Gives no quota protection. | Large advances are expected after normal downtime, so users receive noisy warnings; attackers still succeed. | Local diagnostic data only; MV3-safe if derived from existing snapshot. Low/medium cost. | Do not implement now: no reliable interpretation or safe remediation. |
| External time source | A separately trusted, authenticated remote source could provide independent evidence. | Network failure or blocked access either creates false denial (fail closed) or a bypass (fail open). Network-level adversaries and server availability remain considerations. | Adds a request revealing extension activity/timing; requires explicit privacy, availability, security, and provider review. | Out of scope; only revisit as a dedicated design. |
| Document residual risk | Preserves legitimate downtime semantics and current backward protections. | Does not prevent deliberate forward-jump restoration after restart. | No new permission, storage, external traffic, or lifecycle dependence. | **Recommended.** |

## 5. Recommended policy

Keep current production behavior and explicitly document:

> The persisted wall clock is a restart-survival approximation, not an authenticated elapsed-time source. After an MV3 restart, a forward wall-clock advance is indistinguishable from legitimate downtime and is accepted. Backward observations remain fail-closed.

This is the only option that satisfies both:

- normal shutdown, sleep, update, and long downtime must not become permanent or arbitrary Gemini denial; and
- no external time validation may be added without a separate review.

A "conservative" cap is not conservative for users: it converts expected offline elapsed time into withheld quota availability. Lifecycle markers and alarms add classification hints, not independent time evidence.

## 6. Residual risks

- A user controlling device time can advance it while the worker is absent, restart it, and prematurely clear persisted minute-window reservations/cooldowns and potentially reset RPD.
- A later backward correction triggers fail-closed denial but cannot undo capacity already restored or requests already sent.
- An attacker with write access to extension local storage is outside the clock model and can attempt direct quota-state manipulation.
- The manual repair control (`resetQuotaAccounting`) clears integrity fail-closed states (unsupported version, untrusted migration, malformed snapshots) and rewrites a clean baseline, but it cannot by itself clear a `clock_rollback` caused by wall time below the persisted high-water mark: the repair writes the clamped trusted wall time back as the new high-water mark, so the rollback remains active until the device clock catches up or is corrected. Recovery from a below-high-water rollback therefore requires catching up the clock, not just invoking repair.

## 7. Implementation-issue feasibility

No implementation issue is warranted from this research: no candidate meets the required security benefit without introducing unacceptable normal-downtime false positives or a separately reviewed external dependency.

If product requirements later accept external time validation, that must start as a new design issue freezing: trust source and authentication, privacy disclosure, failure mode, consent/permission model, caching/retention, attack model, and tests for offline, sleep, browser restart, clock forward/backward, and DeepSeek fallback.
