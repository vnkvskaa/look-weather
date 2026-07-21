import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  isQuotaExceededError,
  PHOTO_MAIN,
  PHOTO_THUMB,
} from './media'

describe('photo size defaults', () => {
  it('keeps main photos sharp enough to read outfits', () => {
    expect(PHOTO_MAIN.maxSide).toBeGreaterThanOrEqual(1400)
    expect(PHOTO_MAIN.quality).toBeGreaterThanOrEqual(0.82)
    expect(PHOTO_THUMB.maxSide).toBeLessThan(PHOTO_MAIN.maxSide)
    expect(PHOTO_THUMB.maxSide).toBeGreaterThanOrEqual(400)
  })
})

describe('formatBytes', () => {
  it('formats common sizes in Russian units', () => {
    expect(formatBytes(500)).toBe('500 Б')
    expect(formatBytes(2048)).toBe('2.0 КБ')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 МБ')
  })
})

describe('isQuotaExceededError', () => {
  it('detects QuotaExceededError by name', () => {
    expect(
      isQuotaExceededError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })),
    ).toBe(true)
  })

  it('detects Dexie-style inner quota errors', () => {
    expect(
      isQuotaExceededError({
        name: 'AbortError',
        message: 'Transaction aborted',
        inner: { name: 'QuotaExceededError' },
      }),
    ).toBe(true)
  })
})
