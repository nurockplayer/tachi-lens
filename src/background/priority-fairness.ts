export type FairPriority = 'live' | 'backlog'

export const MAX_CONSECUTIVE_LIVE_SERVICES = 3

export const selectFairPriority = (
  hasLive: boolean,
  hasBacklog: boolean,
  consecutiveLiveServices: number,
): FairPriority | undefined => {
  if (!hasLive) return hasBacklog ? 'backlog' : undefined
  if (!hasBacklog) return 'live'
  return consecutiveLiveServices >= MAX_CONSECUTIVE_LIVE_SERVICES ? 'backlog' : 'live'
}

export const advanceFairServiceCount = (
  current: number,
  priority: FairPriority,
  backlogStillWaiting: boolean,
): number => priority === 'live' && backlogStillWaiting ? current + 1 : 0
