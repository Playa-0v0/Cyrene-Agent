const RECENT_INJECTION_TTL_MS = 10 * 60 * 1000
const MAX_RECENT_INJECTIONS = 20

interface RecentInjection {
  l2Id: string
  injectedAt: number
}

interface SearchEntryWithMetadata {
  text: string
  metadata?: Record<string, unknown>
}

const recentInjections: RecentInjection[] = []

function prune(now: number): void {
  const minTime = now - RECENT_INJECTION_TTL_MS
  for (let i = recentInjections.length - 1; i >= 0; i--) {
    if (recentInjections[i].injectedAt < minTime) {
      recentInjections.splice(i, 1)
    }
  }

  recentInjections.sort((a, b) => b.injectedAt - a.injectedAt)
  if (recentInjections.length > MAX_RECENT_INJECTIONS) {
    recentInjections.splice(MAX_RECENT_INJECTIONS)
  }
}

export function clearRecentMemoryInjections(): void {
  recentInjections.splice(0)
}

export function recordRecentMemoryInjection(l2Ids: string[], now = Date.now()): void {
  for (const l2Id of l2Ids) {
    const existing = recentInjections.find((entry) => entry.l2Id === l2Id)
    if (existing) {
      existing.injectedAt = now
    } else {
      recentInjections.push({ l2Id, injectedAt: now })
    }
  }
  prune(now)
}

export function recordRecentMemorySearchEntries(entries: SearchEntryWithMetadata[], now = Date.now()): void {
  const l2Ids = entries
    .map((entry) => entry.metadata?.l2Id)
    .filter((l2Id): l2Id is string => typeof l2Id === "string" && l2Id.length > 0)
  recordRecentMemoryInjection([...new Set(l2Ids)], now)
}

export function getRecentlyInjectedMemoryIds(now = Date.now()): string[] {
  prune(now)
  return recentInjections
    .slice()
    .sort((a, b) => a.injectedAt - b.injectedAt)
    .map((entry) => entry.l2Id)
}

export function wasRecentlyInjectedMemory(l2Id: string, now = Date.now()): boolean {
  prune(now)
  return recentInjections.some((entry) => entry.l2Id === l2Id)
}
