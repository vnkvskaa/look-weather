import { describe, expect, it } from 'vitest'
import {
  effectiveWarmth,
  isThinAdvice,
  looksNeedingFeedback,
  matchDeltaLabel,
  matchPercent,
  rainAdvice,
  rankDayGroups,
  rankLooks,
  splitPrimaryAdvice,
  weatherTips,
  windAdvice,
} from './recommend'
import { normalizeFeedback } from '../types'
import type { Look, WeatherProfile } from '../types'

function weather(partial: Partial<WeatherProfile>): WeatherProfile {
  return {
    date: '2026-07-01',
    feelsLike: 18,
    tempMean: 17,
    windMs: 2,
    humidity: 50,
    precipMm: 0,
    precipProb: 10,
    cloudCover: 40,
    ...partial,
  }
}

function look(partial: Partial<Look> & Pick<Look, 'id' | 'weather'>): Look {
  return {
    createdAt: 1,
    date: partial.date ?? partial.weather.date,
    placeName: 'Москва',
    latitude: 55.75,
    longitude: 37.62,
    locationSource: 'settings',
    ...partial,
  }
}

describe('normalizeFeedback', () => {
  it('migrates old 3-way values', () => {
    expect(normalizeFeedback('too_cold')).toBe('cold')
    expect(normalizeFeedback('ok')).toBe('ok')
    expect(normalizeFeedback('too_hot')).toBe('hot')
  })

  it('keeps new 5-way values', () => {
    expect(normalizeFeedback('cool')).toBe('cool')
    expect(normalizeFeedback('warm')).toBe('warm')
  })
})

describe('effectiveWarmth', () => {
  it('shifts cold upward (outfit suits warmer weather)', () => {
    const l = look({
      id: '1',
      weather: weather({ feelsLike: 10 }),
      feedback: 'cold',
    })
    expect(effectiveWarmth(l)).toBe(15)
  })

  it('shifts cool halfway up', () => {
    const l = look({
      id: '1',
      weather: weather({ feelsLike: 10 }),
      feedback: 'cool',
    })
    expect(effectiveWarmth(l)).toBe(12.5)
  })

  it('shifts hot downward (outfit suits colder weather)', () => {
    const l = look({
      id: '1',
      weather: weather({ feelsLike: 10 }),
      feedback: 'hot',
    })
    expect(effectiveWarmth(l)).toBe(5)
  })

  it('shifts warm halfway down', () => {
    const l = look({
      id: '1',
      weather: weather({ feelsLike: 10 }),
      feedback: 'warm',
    })
    expect(effectiveWarmth(l)).toBe(7.5)
  })
})

describe('rankLooks', () => {
  it('prefers looks closer in feels-like', () => {
    const target = weather({
      date: '2026-07-20',
      feelsLike: 5,
      precipMm: 0,
      precipProb: 0,
    })
    const cold = look({
      id: 'cold',
      date: '2026-01-01',
      weather: weather({ date: '2026-01-01', feelsLike: 4 }),
    })
    const hot = look({
      id: 'hot',
      date: '2026-06-01',
      weather: weather({ date: '2026-06-01', feelsLike: 28 }),
    })
    const ranked = rankLooks([hot, cold], target, 2)
    expect(ranked[0].look.id).toBe('cold')
    expect(ranked[0].score).toBeLessThan(ranked[1].score)
  })

  it('uses feedback: cold at +10 → match warmer targets', () => {
    const base = look({
      id: 'base',
      date: '2026-03-01',
      weather: weather({ date: '2026-03-01', feelsLike: 10 }),
      feedback: 'cold',
    })
    const other = look({
      id: 'other',
      date: '2026-04-01',
      weather: weather({ date: '2026-04-01', feelsLike: 16 }),
    })
    const warmTarget = weather({ date: '2026-07-20', feelsLike: 14 })
    const ranked = rankLooks([other, base], warmTarget, 2)
    expect(ranked[0].look.id).toBe('base')
    expect(ranked[0].reason).toMatch(/холодно/)
  })

  it('mild favorite boost among similar weather, not bad matches', () => {
    const target = weather({
      date: '2026-07-21',
      feelsLike: 12,
      windMs: 2,
      humidity: 50,
      cloudCover: 40,
    })
    const close = look({
      id: 'close',
      date: '2026-06-01',
      weather: weather({
        date: '2026-06-01',
        feelsLike: 12.4,
        windMs: 2,
        humidity: 50,
        cloudCover: 40,
      }),
    })
    const favClose = look({
      id: 'fav-close',
      date: '2026-05-01',
      favorite: true,
      weather: weather({
        date: '2026-05-01',
        feelsLike: 12.5,
        windMs: 2,
        humidity: 50,
        cloudCover: 40,
      }),
    })
    const favFar = look({
      id: 'fav-far',
      date: '2026-04-01',
      favorite: true,
      weather: weather({
        date: '2026-04-01',
        feelsLike: 28,
        windMs: 2,
        humidity: 50,
        cloudCover: 40,
      }),
    })
    const ranked = rankLooks([close, favClose, favFar], target, 3)
    expect(ranked[0].look.id).toBe('fav-close')
    expect(ranked[2].look.id).toBe('fav-far')
    expect(ranked[0].reason).toMatch(/избранн/)
  })

  it('orders by weather match, not by date or createdAt', () => {
    const target = weather({
      date: '2026-07-21',
      feelsLike: 8,
      windMs: 2,
      humidity: 50,
      cloudCover: 40,
    })
    const recentWrong = look({
      id: 'recent-wrong',
      date: '2026-07-20',
      createdAt: 9_000_000,
      weather: weather({
        date: '2026-07-20',
        feelsLike: 28,
        windMs: 2,
        humidity: 50,
        cloudCover: 40,
      }),
    })
    const oldMatch = look({
      id: 'old-match',
      date: '2025-01-15',
      createdAt: 1_000,
      weather: weather({
        date: '2025-01-15',
        feelsLike: 8,
        windMs: 2,
        humidity: 52,
        cloudCover: 38,
      }),
    })
    const mid = look({
      id: 'mid',
      date: '2026-03-10',
      createdAt: 5_000_000,
      weather: weather({
        date: '2026-03-10',
        feelsLike: 18,
        windMs: 2,
        humidity: 50,
        cloudCover: 40,
      }),
    })

    const ranked = rankLooks([recentWrong, mid, oldMatch], target, 3)
    expect(ranked.map((r) => r.look.id)).toEqual([
      'old-match',
      'mid',
      'recent-wrong',
    ])
    expect(ranked[0].matchPercent).toBeGreaterThan(ranked[1].matchPercent)
    expect(ranked[1].matchPercent).toBeGreaterThan(ranked[2].matchPercent)
    expect(ranked[0].reason).toMatch(/похоже/)
  })

  it('excludes looks from the same calendar day as target', () => {
    const target = weather({ date: '2026-07-21', feelsLike: 12 })
    const sameDay = look({
      id: 'same',
      date: '2026-07-21',
      weather: weather({ date: '2026-07-21', feelsLike: 12 }),
    })
    const other = look({
      id: 'other',
      date: '2026-06-01',
      weather: weather({ date: '2026-06-01', feelsLike: 12 }),
    })
    const ranked = rankLooks([sameDay, other], target, 5)
    expect(ranked.map((r) => r.look.id)).toEqual(['other'])
  })

  it('matchPercent is higher for closer weather', () => {
    expect(matchPercent(0.5)).toBeGreaterThan(matchPercent(12))
  })

  it('adds rain tip when target is wet', () => {
    const target = weather({
      date: '2026-07-21',
      feelsLike: 12,
      precipMm: 3,
      precipProb: 80,
    })
    const dry = look({
      id: 'dry',
      date: '2026-06-01',
      weather: weather({
        date: '2026-06-01',
        feelsLike: 12,
        precipMm: 0,
        precipProb: 5,
      }),
    })
    const ranked = rankLooks([dry], target, 1)
    expect(rainAdvice(target)).toMatch(/защит/)
    expect(ranked[0].reason).toMatch(/защит/)
  })

  it('looksNeedingFeedback returns recent looks without feedback', () => {
    const today = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const iso = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const recent = look({
      id: 'recent',
      date: iso(today),
      weather: weather({ date: iso(today), feelsLike: 10 }),
    })
    const withFb = look({
      id: 'fb',
      date: iso(today),
      weather: weather({ date: iso(today), feelsLike: 10 }),
      feedback: 'ok',
    })
    const old = new Date(today)
    old.setDate(old.getDate() - 10)
    const stale = look({
      id: 'stale',
      date: iso(old),
      weather: weather({ date: iso(old), feelsLike: 10 }),
    })
    expect(looksNeedingFeedback([recent, withFb, stale], 2).map((l) => l.id)).toEqual([
      'recent',
    ])
  })
})

describe('rankDayGroups', () => {
  it('returns one card per calendar date', () => {
    const target = weather({ date: '2026-07-21', feelsLike: 10 })
    const a1 = look({
      id: 'a1',
      date: '2026-06-01',
      time: '09:00',
      weather: weather({ date: '2026-06-01', feelsLike: 9 }),
    })
    const a2 = look({
      id: 'a2',
      date: '2026-06-01',
      time: '18:00',
      weather: weather({ date: '2026-06-01', feelsLike: 28 }),
    })
    const b = look({
      id: 'b',
      date: '2026-05-01',
      weather: weather({ date: '2026-05-01', feelsLike: 20 }),
    })
    const ranked = rankDayGroups([a1, a2, b], target, 5)
    expect(ranked.map((g) => g.date)).toEqual(['2026-06-01', '2026-05-01'])
    expect(ranked[0].looks).toHaveLength(2)
    expect(ranked[0].best.look.id).toBe('a1')
  })

  it('splitPrimaryAdvice puts best day first', () => {
    const target = weather({ date: '2026-07-21', feelsLike: 10 })
    const close = look({
      id: 'close',
      date: '2026-06-01',
      weather: weather({ date: '2026-06-01', feelsLike: 10 }),
    })
    const far = look({
      id: 'far',
      date: '2026-05-01',
      weather: weather({ date: '2026-05-01', feelsLike: 28 }),
    })
    const mid = look({
      id: 'mid',
      date: '2026-04-01',
      weather: weather({ date: '2026-04-01', feelsLike: 16 }),
    })
    const ranked = rankDayGroups([far, mid, close], target, 5)
    const { primary, rest } = splitPrimaryAdvice(ranked)
    expect(primary?.date).toBe('2026-06-01')
    expect(rest.map((g) => g.date)).toEqual(['2026-04-01', '2026-05-01'])
  })
})

describe('thin advice messaging', () => {
  it('flags archive with fewer than 3 distinct days', () => {
    const a = look({
      id: 'a',
      date: '2026-06-01',
      weather: weather({ date: '2026-06-01', feelsLike: 12 }),
    })
    const b = look({
      id: 'b',
      date: '2026-05-01',
      weather: weather({ date: '2026-05-01', feelsLike: 12 }),
    })
    expect(isThinAdvice([a, b], '2026-07-21')).toBe(true)
  })

  it('ok when enough days and strong top match', () => {
    const looks = [1, 2, 3].map((n) =>
      look({
        id: `d${n}`,
        date: `2026-0${n}-01`,
        weather: weather({ date: `2026-0${n}-01`, feelsLike: 12 }),
      }),
    )
    const ranked = rankDayGroups(
      looks,
      weather({ date: '2026-07-21', feelsLike: 12 }),
      5,
    )
    expect(isThinAdvice(looks, '2026-07-21', ranked[0])).toBe(false)
  })

  it('flags weak top match even with enough days', () => {
    const looks = [1, 2, 3].map((n) =>
      look({
        id: `hot${n}`,
        date: `2026-0${n}-15`,
        weather: weather({
          date: `2026-0${n}-15`,
          feelsLike: 30,
          windMs: 2,
          humidity: 50,
          cloudCover: 40,
        }),
      }),
    )
    const ranked = rankDayGroups(
      looks,
      weather({
        date: '2026-07-21',
        feelsLike: 0,
        windMs: 2,
        humidity: 50,
        cloudCover: 40,
      }),
      5,
    )
    expect(ranked[0].matchPercent).toBeLessThan(55)
    expect(isThinAdvice(looks, '2026-07-21', ranked[0])).toBe(true)
  })

  it('matchDeltaLabel softens loud percent', () => {
    expect(matchDeltaLabel(12, 12)).toBe('+12°')
    expect(matchDeltaLabel(14.2, 10)).toBe('ближе к +14°')
    expect(matchDeltaLabel(-3, 0)).toBe('ближе к -3°')
  })
})

describe('weatherTips', () => {
  it('adds wind tip when strong', () => {
    const tip = windAdvice(weather({ windMs: 9 }))
    expect(tip).toMatch(/ветер/)
    expect(
      weatherTips(weather({ windMs: 9, precipMm: 0, precipProb: 0 })),
    ).toContain(tip!)
  })
})
