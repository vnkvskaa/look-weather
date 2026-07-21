import type { Feedback, Look, RankedLook, WeatherProfile } from '../types'

const FEEDBACK_SHIFT: Record<Feedback, number> = {
  too_cold: -3.5,
  ok: 0,
  too_hot: 3.5,
}

export function effectiveWarmth(look: Look): number {
  const shift = look.feedback ? FEEDBACK_SHIFT[look.feedback] : 0
  return look.weather.feelsLike + shift
}

function precipScore(target: WeatherProfile, look: WeatherProfile): number {
  const tWet = target.precipMm >= 1 || target.precipProb >= 50
  const lWet = look.precipMm >= 1 || look.precipProb >= 50
  if (tWet === lWet) return 0
  return 8
}

export function rankLooks(
  looks: Look[],
  target: WeatherProfile,
  limit = 8,
): RankedLook[] {
  const ranked = looks.map((look) => {
    const warmth = effectiveWarmth(look)
    const tempDiff = Math.abs(target.feelsLike - warmth)
    const windDiff = Math.abs(target.windMs - look.weather.windMs)
    const humidDiff = Math.abs(target.humidity - look.weather.humidity) / 12
    const cloudDiff = Math.abs(target.cloudCover - look.weather.cloudCover) / 25
    const precip = precipScore(target, look.weather)

    const score =
      tempDiff * 1.6 + windDiff * 0.7 + humidDiff + cloudDiff + precip

    const reasonBits: string[] = []
    reasonBits.push(
      `теплота ~${Math.round(warmth)}° (день лука ${Math.round(look.weather.feelsLike)}°)`,
    )
    if (look.feedback === 'too_cold') reasonBits.push('учитываю: было холодно')
    if (look.feedback === 'too_hot') reasonBits.push('учитываю: было жарко')
    if (precip > 0) {
      reasonBits.push(
        target.precipMm >= 1 || target.precipProb >= 50
          ? 'в целевой день сыро — лук был в сухой день'
          : 'лук был в дождь — сегодня суше',
      )
    } else if (look.weather.windMs >= 4.5 && target.windMs >= 4.5) {
      reasonBits.push('похожий ветер')
    }

    return {
      look,
      score,
      effectiveWarmth: warmth,
      reason: reasonBits.join(' · '),
    }
  })

  return ranked.sort((a, b) => a.score - b.score).slice(0, limit)
}
