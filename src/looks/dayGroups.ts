import type { DayGroup, Look } from '../types'

/** Minutes from midnight; missing time → midday (neutral). */
function timeMinutes(time?: string): number {
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return 12 * 60
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function placeCompleteness(look: Look): number {
  let score = 0
  if (look.placeName?.trim()) score += 2
  if (look.locationSource === 'photo' || look.locationSource === 'search') {
    score += 2
  } else if (look.locationSource === 'geo') {
    score += 1
  }
  if (Number.isFinite(look.latitude) && Number.isFinite(look.longitude)) {
    score += 1
  }
  return score
}

/**
 * Pick the look that best represents the day:
 * closest outing time (if given), then richest location, then newest.
 */
export function pickPrimaryLook(
  looks: Look[],
  outingTime?: string,
): Look {
  if (looks.length === 1) return looks[0]
  const targetMin = timeMinutes(outingTime)

  return [...looks].sort((a, b) => {
    const timeDiff =
      Math.abs(timeMinutes(a.time) - targetMin) -
      Math.abs(timeMinutes(b.time) - targetMin)
    if (timeDiff !== 0) return timeDiff

    const placeDiff = placeCompleteness(b) - placeCompleteness(a)
    if (placeDiff !== 0) return placeDiff

    return b.createdAt - a.createdAt
  })[0]
}

/** Sort looks within a day: by time, then createdAt. */
export function sortLooksInDay(looks: Look[]): Look[] {
  return [...looks].sort((a, b) => {
    const ta = a.time ? timeMinutes(a.time) : 24 * 60
    const tb = b.time ? timeMinutes(b.time) : 24 * 60
    if (ta !== tb) return ta - tb
    return a.createdAt - b.createdAt
  })
}

/** Group looks by calendar date (newest dates first). */
export function groupLooksByDate(
  looks: Look[],
  outingTime?: string,
): DayGroup[] {
  const byDate = new Map<string, Look[]>()
  for (const look of looks) {
    const list = byDate.get(look.date) ?? []
    list.push(look)
    byDate.set(look.date, list)
  }

  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a))
  return dates.map((date) => {
    const dayLooks = sortLooksInDay(byDate.get(date)!)
    return {
      date,
      looks: dayLooks,
      primary: pickPrimaryLook(dayLooks, outingTime),
    }
  })
}

/** Shared place line: primary name, or «A · +N ещё» on conflict. */
export function placeSummary(group: DayGroup): string {
  const names = [
    ...new Set(
      group.looks
        .map((l) => l.placeName?.trim())
        .filter((n): n is string => Boolean(n)),
    ),
  ]
  if (names.length === 0) return group.primary.placeName || '—'
  if (names.length === 1) return names[0]
  const primary = group.primary.placeName?.trim() || names[0]
  const extra = names.length - 1
  return `${primary} · +${extra} ещё`
}

/** Weather line from the primary look (shared card summary). */
export function weatherSummaryBits(group: DayGroup): {
  feelsLike: number
  place: string
  count: number
} {
  return {
    feelsLike: group.primary.weather.feelsLike,
    place: placeSummary(group),
    count: group.looks.length,
  }
}
