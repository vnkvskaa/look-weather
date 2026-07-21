import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_BACKUP_LOOK_DELAY_MS,
  AUTO_BACKUP_MIN_INTERVAL_MS,
  _resetAutoBackupForTests,
  getAutoBackupStatus,
  isAutoBackupEnabled,
  scheduleAutoBackup,
  subscribeAutoBackup,
  suppressAutoBackup,
} from './autoBackup'

vi.mock('../db', () => ({
  getSettings: vi.fn(async () => ({
    placeName: 'Москва',
    latitude: 55.75,
    longitude: 37.62,
    githubToken: 'ghp_test',
    githubAutoBackup: true,
  })),
}))

vi.mock('./githubBackup', () => ({
  saveBackupToGithub: vi.fn(async () => ({
    repoFullName: 'user/look-weather-data',
    photosUploaded: 1,
    photosSkipped: 0,
    looksTotal: 1,
    bytesUploaded: 1000,
  })),
}))

import { getSettings } from '../db'
import { saveBackupToGithub } from './githubBackup'

describe('isAutoBackupEnabled', () => {
  it('is on by default when token exists', () => {
    expect(
      isAutoBackupEnabled({ githubToken: 'ghp_x', githubAutoBackup: undefined }),
    ).toBe(true)
  })

  it('respects explicit off', () => {
    expect(
      isAutoBackupEnabled({ githubToken: 'ghp_x', githubAutoBackup: false }),
    ).toBe(false)
  })

  it('skips without token', () => {
    expect(isAutoBackupEnabled({ githubAutoBackup: true })).toBe(false)
  })
})

describe('scheduleAutoBackup', () => {
  afterEach(() => {
    _resetAutoBackupForTests()
    vi.mocked(saveBackupToGithub).mockClear()
    vi.mocked(getSettings).mockClear()
    vi.useRealTimers()
  })

  it('runs after look delay and reports ok', async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const unsub = subscribeAutoBackup((s) => statuses.push(s.kind))

    scheduleAutoBackup('look')
    expect(getAutoBackupStatus().kind).toBe('pending')
    expect(saveBackupToGithub).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(AUTO_BACKUP_LOOK_DELAY_MS)
    await Promise.resolve()
    await Promise.resolve()

    expect(saveBackupToGithub).toHaveBeenCalledTimes(1)
    expect(statuses).toContain('saving')
    expect(getAutoBackupStatus().kind).toBe('ok')
    unsub()
  })

  it('coalesces rapid schedules into one upload', async () => {
    vi.useFakeTimers()
    scheduleAutoBackup('feedback')
    scheduleAutoBackup('feedback')
    scheduleAutoBackup('look')

    await vi.advanceTimersByTimeAsync(AUTO_BACKUP_LOOK_DELAY_MS)
    await Promise.resolve()
    await Promise.resolve()

    expect(saveBackupToGithub).toHaveBeenCalledTimes(1)
  })

  it('skips silently when suppressed after restore', async () => {
    vi.useFakeTimers()
    suppressAutoBackup(60_000)
    scheduleAutoBackup('look')
    await vi.advanceTimersByTimeAsync(AUTO_BACKUP_MIN_INTERVAL_MS)
    await Promise.resolve()
    expect(saveBackupToGithub).not.toHaveBeenCalled()
    expect(getAutoBackupStatus().kind).toBe('idle')
  })

  it('skips when auto backup is off', async () => {
    vi.useFakeTimers()
    vi.mocked(getSettings).mockResolvedValueOnce({
      placeName: 'Москва',
      latitude: 55.75,
      longitude: 37.62,
      githubToken: 'ghp_test',
      githubAutoBackup: false,
    })
    scheduleAutoBackup('look')
    await vi.advanceTimersByTimeAsync(AUTO_BACKUP_LOOK_DELAY_MS)
    await Promise.resolve()
    await Promise.resolve()
    expect(saveBackupToGithub).not.toHaveBeenCalled()
  })
})
