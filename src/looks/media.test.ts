import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  isQuotaExceededError,
  PHOTO_MAIN,
  PHOTO_THUMB,
} from './media'

describe('photo size defaults', () => {
  it('uses aggressive main + thumb limits', () => {
    expect(PHOTO_MAIN.maxSide).toBeLessThanOrEqual(1100)
    expect(PHOTO_MAIN.quality).toBeLessThanOrEqual(0.75)
    expect(PHOTO_THUMB.maxSide).toBeLessThanOrEqual(400)
    expect(PHOTO_THUMB.quality).toBeLessThanOrEqual(0.75)
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
