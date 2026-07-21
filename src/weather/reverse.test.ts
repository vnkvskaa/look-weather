import { describe, expect, it, vi, afterEach } from 'vitest'
import { formatPlaceShort, reverseGeocode } from './api'

describe('formatPlaceShort', () => {
  it('keeps city, country', () => {
    expect(formatPlaceShort('Фетхие, Турция')).toBe('Фетхие, Турция')
  })

  it('drops middle admin region', () => {
    expect(formatPlaceShort('Фетхие, Мугла, Турция')).toBe('Фетхие, Турция')
  })

  it('handles single token', () => {
    expect(formatPlaceShort('Москва')).toBe('Москва')
  })
})

describe('reverseGeocode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds city, country without subdivision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          city: 'Фетхие',
          principalSubdivision: 'Мугла',
          countryName: 'Турция',
        }),
      })),
    )
    const place = await reverseGeocode(36.6, 29.1)
    expect(place.name).toBe('Фетхие, Турция')
  })
})
