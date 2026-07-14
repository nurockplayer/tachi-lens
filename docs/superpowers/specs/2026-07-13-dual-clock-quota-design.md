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

On restoration, the store converts each persisted reservation and cooldown into a remaining duration anchored at the new worker's monotonic reading. The conversion uses `max(currentWall, wallHighWaterMark)` as the trusted wall reference. If `currentWall < wallHighWaterMark`, the store enters clock-rollback mode, retains all state, and denies Gemini reservations with `clock_rollback` until wall time catches up.

Version-2 migration derives a conservative high-water mark only when every bucket is structurally complete and at least one valid persisted reservation timestamp supplies a trusted observation. If the snapshot is incomplete or has no safe observation, `clockTrusted` remains false across the v3 rewrite and the state stays fail closed until it is explicitly repaired instead of silently becoming permissive after a timer or day transition.

When `clockTrusted` is false (e.g. incomplete v2 migration, unknown future version), wall time catching up to or exceeding the high-water mark does NOT clear the rollback latch. The store requires an explicit repair step — typically a new persisted snapshot from a future store instance that successfully loads with a valid high-water mark and sets `clockTrusted=true`. Without this, the snapshot remains fail-closed across restarts even if wall time appears healthy.

## Runtime behavior

Within a worker, wall adjustments never alter monotonic reservation expiries, scheduler deadlines, or cooldown deadlines. Trusted wall time can advance no faster than monotonic elapsed time, so a forward wall jump cannot reset RPD before elapsed time proves the Pacific-day boundary was crossed. A backward wall observation activates fail-closed routing without pruning reservations, changing provider day, reducing RPD, or shortening cooldowns. DeepSeek remains available because the scheduler treats `clock_rollback` as a bounded quota denial with no future Gemini wake time.

When wall time catches up, the rollback latch clears. Monotonic elapsed time may then safely prune in-process state. The repaired state and the nondecreasing high-water mark are persisted.

## Provider day

Provider-day strings must pass real Gregorian `YYYY-MM-DD` validation before comparison. RPD resets only if the current valid Pacific date is lexically later than the stored valid date and the wall clock is not behind its trusted high-water mark. Earlier, invalid, or ambiguous dates retain the existing provider day and count.

## Tests

Store tests cover backward wall movement with full RPM/TPM, Pacific-date rollback across PDT and PST, restart behind the high-water mark, cooldown retention, recovery, high-water monotonicity, and version-2 migration. Scheduler/Translator tests use the real `Translator -> QuotaScheduler -> GeminiQuotaStore -> Provider` path to verify `clock_rollback` overflow, no Gemini dispatch while fail closed, DeepSeek availability, and monotonic live deadlines despite wall adjustment.
