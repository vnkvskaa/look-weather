import { describe, expect, it } from 'vitest'
import { weatherLabel, formatFeels } from '../weather/api'
import type { WeatherProfile } from '../types'

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

describe('weatherLabel', () => {
  it('mentions rain and wind', () => {
    const label = weatherLabel(
      weather({ precipMm: 3, precipProb: 80, windMs: 6, feelsLike: 4 }),
    )
    expect(label).toContain('дождь')
    expect(label).toContain('ветрено')
    expect(label).toContain('+4°')
  })
})

describe('formatFeels', () => {
  it('adds plus for positive', () => {
    expect(formatFeels(12.4)).toBe('+12°')
  })
  it('keeps minus for negative', () => {
    expect(formatFeels(-3.2)).toBe('-3°')
  })
})
