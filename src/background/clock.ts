export interface Clock {
  monotonicNow(): number
  wallNow(): number
}

export const createSystemClock = (): Clock => ({
  monotonicNow: () => globalThis.performance.now(),
  wallNow: () => Date.now(),
})
