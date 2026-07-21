import { describe, expect, it, vi, afterEach } from 'vitest'
import { reverseGeocode } from './api'

describe('reverseGeocode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds a readable place name from reverse API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          city: 'Севастополь',
          principalSubdivision: 'Севастополь',
          countryName: 'Россия',
        }),
      })),
    )
    const place = await reverseGeocode(44.6, 33.5)
    expect(place.name).toContain('Севастополь')
    expect(place.latitude).toBe(44.6)
  })
})
