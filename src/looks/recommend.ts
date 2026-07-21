import type { Feedback, Look, RankedLook, WeatherProfile } from '../types'

/**
 * Feedback is about the outfit on that day's weather:
 * - too_cold → clothes were too thin for W → comfort point is warmer than W
 * - too_hot  → clothes were too warm for W → comfort point is colder than W
 */
const FEEDBACK_SHIFT: Record<Feedback, number> = {
  too_cold: 3.5,
  ok: 0,
  too_hot: -3.5,
}

export function effectiveWarmth(look: Look): number {
  const shift = look.feedback ? FEEDBACK_SHIFT[look.feedback] : 0
  return look.weather.feelsLike + shift
}

function precipMismatch(target: WeatherProfile, look: WeatherProfile): number {
  const tWet = target.precipMm >= 1 || target.precipProb >= 50
  const lWet = look.precipMm >= 1 || look.precipProb >= 50
  return tWet === lWet ? 0 : 1
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
  const distance =
    tempDiff * 2.4 +
    windDiff * 0.55 +
    humidDiff / 18 +
    cloudDiff / 30 +
    precip * 6

  return { distance, warmth }
}

/** Map distance → 0–100 match %. Tuned so a near-perfect day ≈ 90–100. */
export function matchPercent(distance: number): number {
  const pct = Math.round(100 * Math.exp(-distance / 9))
  return Math.max(1, Math.min(99, pct))
}

function buildReason(
  look: Look,
  target: WeatherProfile,
  warmth: number,
  pct: number,
): string {
  const bits: string[] = [`совпадение ${pct}%`]

  const tempGap = Math.round(target.feelsLike - warmth)
  if (Math.abs(tempGap) <= 1) {
    bits.push('почти та же теплота')
  } else if (tempGap > 0) {
    bits.push(`лук чуть прохладнее цели (~${Math.round(warmth)}°)`)
  } else {
    bits.push(`лук чуть теплее цели (~${Math.round(warmth)}°)`)
  }

  if (look.feedback === 'too_cold') {
    bits.push('в той одежде было холодно')
  } else if (look.feedback === 'too_hot') {
    bits.push('в той одежде было жарко')
  }

  if (precipMismatch(target, look.weather)) {
    bits.push(
      target.precipMm >= 1 || target.precipProb >= 50
        ? 'сейчас сыро — лук был в сухой день'
        : 'лук был в дождь — сейчас суше',
    )
  } else if (look.weather.windMs >= 4.5 && target.windMs >= 4.5) {
    bits.push('похожий ветер')
  }

  return bits.join(' · ')
}

export function rankLooks(
  looks: Look[],
  target: WeatherProfile,
  limit = 8,
): RankedLook[] {
  // Same calendar day as the target confuses “recommendation” with “today’s entry”.
  const candidates = looks.filter((look) => look.date !== target.date)

  const ranked = candidates.map((look) => {
    const { distance, warmth } = weatherDistance(target, look)
    const pct = matchPercent(distance)
    return {
      look,
      score: distance,
      matchPercent: pct,
      effectiveWarmth: warmth,
      reason: buildReason(look, target, warmth, pct),
    }
  })

  // Ascending distance = best weather match first. Tie-break: higher match %, then id.
  ranked.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.matchPercent !== b.matchPercent) return b.matchPercent - a.matchPercent
    return a.look.id.localeCompare(b.look.id)
  })

  return ranked.slice(0, limit)
}
