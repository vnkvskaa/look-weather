import { describe, expect, it } from 'vitest'
import { effectiveWarmth, rankLooks } from './recommend'
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
    date: partial.weather.date,
    photoBlob: new Blob(),
    placeName: 'Москва',
    latitude: 55.75,
    longitude: 37.62,
    locationSource: 'settings',
    ...partial,
  }
}

describe('effectiveWarmth', () => {
  it('shifts colder feedback down', () => {
    const l = look({
      id: '1',
      weather: weather({ feelsLike: 10 }),
      feedback: 'too_cold',
    })
    expect(effectiveWarmth(l)).toBe(6.5)
  })

  it('shifts hotter feedback up', () => {
    const l = look({
      id: '1',
      weather: weather({ feelsLike: 10 }),
      feedback: 'too_hot',
    })
    expect(effectiveWarmth(l)).toBe(13.5)
  })
})

describe('rankLooks', () => {
  it('prefers looks closer in feels-like', () => {
    const target = weather({ feelsLike: 5, precipMm: 0, precipProb: 0 })
    const cold = look({
      id: 'cold',
      weather: weather({ date: '2026-01-01', feelsLike: 4 }),
    })
    const hot = look({
      id: 'hot',
      weather: weather({ date: '2026-06-01', feelsLike: 28 }),
    })
    const ranked = rankLooks([hot, cold], target, 2)
    expect(ranked[0].look.id).toBe('cold')
    expect(ranked[0].score).toBeLessThan(ranked[1].score)
  })

  it('uses feedback when ranking', () => {
    const target = weather({ feelsLike: 6 })
    const base = look({
      id: 'base',
      weather: weather({ feelsLike: 10 }),
      feedback: 'too_cold', // effective 6.5
    })
    const other = look({
      id: 'other',
      weather: weather({ feelsLike: 16 }),
    })
    const ranked = rankLooks([other, base], target, 2)
    expect(ranked[0].look.id).toBe('base')
  })
})
