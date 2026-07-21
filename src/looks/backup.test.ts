import { describe, expect, it } from 'vitest'
import { shouldRemindBackup, settingsForBackup } from './backup'
import type { Settings } from '../types'

const base: Settings = {
  placeName: 'Москва',
  latitude: 55.75,
  longitude: 37.62,
}

describe('settingsForBackup', () => {
  it('strips github token and legacy gist id from exportable settings', () => {
    const out = settingsForBackup({
      ...base,
      githubToken: 'ghp_secret',
      githubGistId: 'abc123',
      githubRepoFullName: 'user/look-weather-data',
      githubAutoBackup: true,
      githubRepoTokenValidatedAt: 1,
      backupSetupStep: 'ready',
      homePlace: { placeName: 'Москва', latitude: 55.75, longitude: 37.62 },
      travelPlace: { placeName: 'Стамбул', latitude: 41.01, longitude: 28.97 },
    })
    expect(out.githubToken).toBeUndefined()
    expect(out.githubGistId).toBeUndefined()
    expect(out.githubRepoFullName).toBe('user/look-weather-data')
    expect(out.githubAutoBackup).toBe(true)
    expect(out.githubRepoTokenValidatedAt).toBe(1)
    expect(out.backupSetupStep).toBe('ready')
    expect(out.homePlace?.placeName).toBe('Москва')
    expect(out.travelPlace?.placeName).toBe('Стамбул')
  })
})

describe('shouldRemindBackup', () => {
  it('stays quiet with no looks', () => {
    expect(shouldRemindBackup(base, 0)).toBe(false)
  })

  it('reminds after 3 new looks since last backup', () => {
    expect(
      shouldRemindBackup({ ...base, looksCountAtBackup: 1, lastBackupAt: Date.now() }, 4),
    ).toBe(true)
  })

  it('respects recent dismiss', () => {
    expect(
      shouldRemindBackup(
        {
          ...base,
          looksCountAtBackup: 0,
          backupReminderDismissedAt: Date.now(),
        },
        5,
      ),
    ).toBe(false)
  })
})
