// Backoff Strategy Interface
// Supports different backoff strategies (exponential, linear, fixed).

export interface BackoffStrategy {
  /** Calculate the next backoff delay in milliseconds. */
  nextDelay(attempt: number): number
}

/** Exponential backoff: base * 2^attempt */
export class ExponentialBackoff implements BackoffStrategy {
  constructor(
    private baseMs: number = 1_000,
    private maxMs: number = 60_000,
  ) {}

  nextDelay(attempt: number): number {
    const delay = this.baseMs * Math.pow(2, attempt)
    return Math.min(delay, this.maxMs)
  }
}

/** Linear backoff: base * attempt */
export class LinearBackoff implements BackoffStrategy {
  constructor(
    private baseMs: number = 1_000,
    private maxMs: number = 60_000,
  ) {}

  nextDelay(attempt: number): number {
    const delay = this.baseMs * attempt
    return Math.min(delay, this.maxMs)
  }
}

/** Fixed backoff: constant delay */
export class FixedBackoff implements BackoffStrategy {
  constructor(private delayMs: number = 5_000) {}

  nextDelay(_attempt?: number): number {
    return this.delayMs
  }
}