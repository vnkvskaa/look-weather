import type {
  Feedback,
  Look,
  RankedDayGroup,
  RankedLook,
  WeatherProfile,
} from '../types'
import { FEEDBACK_LABEL } from '../types'
import { groupLooksByDate } from './dayGroups'

/**
 * Feedback is about the outfit on that day's weather:
 * - cold / cool → clothes were too thin for W → comfort point is warmer than W
 * - warm / hot  → clothes were too warm for W → comfort point is colder than W
 *
 * Shifts in °C comfort point (symmetric around ok).
 */
const FEEDBACK_SHIFT: Record<Feedback, number> = {
  cold: 5,
  cool: 2.5,
  ok: 0,
  warm: -2.5,
  hot: -5,
}

/**
 * Mild favorite boost — only when already weather-similar.
 * Cap keeps a starred bad match from beating a clearly better day.
 */
const FAVORITE_SIMILAR_MAX = 10
const FAVORITE_BONUS = 0.85

export function effectiveWarmth(look: Look): number {
  const shift = look.feedback ? FEEDBACK_SHIFT[look.feedback] : 0
  return look.weather.feelsLike + shift
}

export function isWet(profile: WeatherProfile): boolean {
  return profile.precipMm >= 1 || profile.precipProb >= 50
}

/** Short tip when target weather is wet — for UI banners / reasons. */
export function rainAdvice(target: WeatherProfile): string | null {
  if (!isWet(target)) return null
  if (target.precipMm >= 2 || target.precipProb >= 70) {
    return 'возьми защиту от дождя'
  }
  return 'возможен дождь'
}

export function windAdvice(target: WeatherProfile): string | null {
  if (target.windMs >= 8) return 'сильный ветер'
  if (target.windMs >= 5.5) return 'ветрено'
  return null
}

export function humidityAdvice(target: WeatherProfile): string | null {
  if (target.humidity >= 85) return 'очень влажно'
  if (target.humidity <= 25 && target.humidity > 0) return 'сухо'
  return null
}

/** Combine short weather tips (rain / wind / humidity). */
export function weatherTips(target: WeatherProfile): string[] {
  return [rainAdvice(target), windAdvice(target), humidityAdvice(target)].filter(
    (t): t is string => Boolean(t),
  )
}

function precipMismatch(target: WeatherProfile, look: WeatherProfile): number {
  return isWet(target) === isWet(look) ? 0 : 1
}

/** Lower distance = better weather match. Not related to date/createdAt. */
export function weatherDistance(
  target: WeatherProfile,
  look: Look,
): { distance: number; warmth: number } {
  const warmth = effectiveWarmth(look)
  const tempDiff = Math.abs(target.feelsLike - warmth)
  const windDiff = Math.abs(target.windMs - look.weather.windMs)
  const humidDiff = Math.abs(target.humidity - look.weather.humidity)
  const cloudDiff = Math.abs(target.cloudCover - look.weather.cloudCover)
  const precip = precipMismatch(target, look.weather)

  // Stronger weight on feels-like; other factors are secondary.
  let distance =
    tempDiff * 2.4 +
    windDiff * 0.55 +
    humidDiff / 18 +
    cloudDiff / 30 +
    precip * 6

  // Favorite: mild nudge only among already similar weather.
  if (look.favorite && distance <= FAVORITE_SIMILAR_MAX) {
    distance = Math.max(0, distance - FAVORITE_BONUS)
  }

  return { distance, warmth }
}

/** Map distance → 0–100 match %. Tuned so a near-perfect day ≈ 90–100. */
export function matchPercent(distance: number): number {
  const pct = Math.round(100 * Math.exp(-distance / 9))
  return Math.max(1, Math.min(99, pct))
}

/** One short plain line under a card — no jargon stack. */
function buildReason(
  look: Look,
  target: WeatherProfile,
  _warmth: number,
  _pct: number,
): string {
  if (precipMismatch(target, look.weather) && isWet(target)) {
    return 'похоже · возьми защиту от дождя'
  }
  if (isWet(target)) {
    return rainAdvice(target) ?? 'похоже · возьми защиту от дождя'
  }

  if (look.feedback && look.feedback !== 'ok') {
    return `похоже · тогда было ${FEEDBACK_LABEL[look.feedback]}`
  }
  if (look.favorite) {
    return 'похоже · из избранного'
  }

  const wind = windAdvice(target)
  if (wind) return `похоже · ${wind}`
  return 'похоже'
}

function rankOne(look: Look, target: WeatherProfile): RankedLook {
  const { distance, warmth } = weatherDistance(target, look)
  const pct = matchPercent(distance)
  return {
    look,
    score: distance,
    matchPercent: pct,
    effectiveWarmth: warmth,
    reason: buildReason(look, target, warmth, pct),
  }
}

export function rankLooks(
  looks: Look[],
  target: WeatherProfile,
  limit = 8,
): RankedLook[] {
  // Same calendar day as the target confuses “recommendation” with “today’s entry”.
  const candidates = looks.filter((look) => look.date !== target.date)

  const ranked = candidates.map((look) => rankOne(look, target))

  // Ascending distance = best weather match first. Tie-break: higher match %, then id.
  ranked.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.matchPercent !== b.matchPercent) return b.matchPercent - a.matchPercent
    return a.look.id.localeCompare(b.look.id)
  })

  return ranked.slice(0, limit)
}

/**
 * Rank by calendar day: one card per date, scored by the best look inside.
 * Multiple looks on the same date never appear as separate recommendation cards.
 */
export function rankDayGroups(
  looks: Look[],
  target: WeatherProfile,
  limit = 8,
  outingTime?: string,
): RankedDayGroup[] {
  const candidates = looks.filter((look) => look.date !== target.date)
  const groups = groupLooksByDate(candidates, outingTime)

  const ranked: RankedDayGroup[] = groups.map((group) => {
    const scored = group.looks.map((look) => rankOne(look, target))
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      if (a.matchPercent !== b.matchPercent) {
        return b.matchPercent - a.matchPercent
      }
      return a.look.id.localeCompare(b.look.id)
    })
    const best = scored[0]
    return {
      ...group,
      // Prefer outing-time primary, but keep best-match look as ranking anchor
      primary: group.primary,
      score: best.score,
      matchPercent: best.matchPercent,
      reason: best.reason,
      effectiveWarmth: best.effectiveWarmth,
      best,
    }
  })

  ranked.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.matchPercent !== b.matchPercent) return b.matchPercent - a.matchPercent
    return b.date.localeCompare(a.date)
  })

  return ranked.slice(0, limit)
}

/** Looks from the last `days` calendar days without comfort feedback. */
export function looksNeedingFeedback(looks: Look[], days = 2): Look[] {
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (days - 1))
  const cutoffIso = localISODate(cutoff)

  return looks
    .filter((look) => !look.feedback && look.date >= cutoffIso)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
}

function localISODate(d: Date): string {
  const off = d.getTimezoneOffset()
  const local = new Date(d.getTime() - off * 60_000)
  return local.toISOString().slice(0, 10)
}
