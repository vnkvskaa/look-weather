import { listLooks, mergeLooks, getSettings, saveSettings } from '../db'
import type { Look, LookExport, Place, Settings } from '../types'
import { base64ToBlob, blobToBase64, compressImage } from './media'

export type BackupPayload = {
  version: 1
  exportedAt: string
  settings: Settings
  looks: LookExport[]
}

function placeForBackup(place?: Place): Place | undefined {
  if (!place) return undefined
  return {
    placeName: place.placeName,
    latitude: place.latitude,
    longitude: place.longitude,
  }
}

/** Settings fields safe to put in a shareable / gist JSON (no PAT). */
export function settingsForBackup(settings: Settings): Settings {
  return {
    placeName: settings.placeName,
    latitude: settings.latitude,
    longitude: settings.longitude,
    cityConfirmed: settings.cityConfirmed,
    homePlace: placeForBackup(settings.homePlace),
    travelPlace: placeForBackup(settings.travelPlace),
    githubGistId: settings.githubGistId,
    githubAutoBackup: settings.githubAutoBackup,
    lastBackupAt: settings.lastBackupAt,
    looksCountAtBackup: settings.looksCountAtBackup,
    backupReminderDismissedAt: settings.backupReminderDismissedAt,
  }
}

export type ImportResult = {
  imported: number
  total: number
}

export type BackupBuildOptions = {
  /** Re-encode photos smaller for gist size limits */
  recompress?: { maxSide: number; quality: number }
}

export async function buildBackup(
  options: BackupBuildOptions = {},
): Promise<BackupPayload> {
  const [looks, settings] = await Promise.all([listLooks(), getSettings()])
  const exported: LookExport[] = []
  for (const look of looks) {
    let photoBlob = look.photoBlob
    if (options.recompress) {
      const file = new File([photoBlob], 'look.jpg', {
        type: photoBlob.type || 'image/jpeg',
      })
      photoBlob = await compressImage(
        file,
        options.recompress.maxSide,
        options.recompress.quality,
      )
    }
    const { photoBlob: _blob, ...rest } = look
    exported.push({
      ...rest,
      photoBase64: await blobToBase64(photoBlob),
    })
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: settingsForBackup(settings),
    looks: exported,
  }
}

export async function shareOrDownloadBackup(): Promise<void> {
  const payload = await buildBackup()
  const text = JSON.stringify(payload)
  const blob = new Blob([text], { type: 'application/json' })
  const filename = `look-weather-${payload.exportedAt.slice(0, 10)}.json`

  const file = new File([blob], filename, { type: 'application/json' })
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: 'look. backup',
      text: 'Бэкап луков — сохрани в Файлы / iCloud Drive',
    })
    return
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function importBackupPayload(
  data: BackupPayload,
): Promise<ImportResult> {
  if (data.version !== 1 || !Array.isArray(data.looks)) {
    throw new Error('Неверный формат бэкапа')
  }

  const looks: Look[] = data.looks.map((item) => {
    const { photoBase64, ...rest } = item
    return {
      ...rest,
      photoBlob: base64ToBlob(photoBase64),
    }
  })

  const current = await getSettings()
  // Merge by id — local-only looks stay; same id gets backup version
  const { imported, total } = await mergeLooks(looks)
  if (data.settings) {
    const fromBackup = settingsForBackup(data.settings)
    await saveSettings({
      ...current,
      ...fromBackup,
      // Keep local PAT — never overwrite from backup JSON
      githubToken: current.githubToken,
      githubGistId:
        data.settings.githubGistId || current.githubGistId,
      // Prefer local home if backup has none
      homePlace: fromBackup.homePlace ?? current.homePlace,
    })
  }
  return { imported, total }
}

export async function importBackupFile(file: File): Promise<ImportResult> {
  const text = await file.text()
  const data = JSON.parse(text) as BackupPayload
  return importBackupPayload(data)
}

/** Soft reminder: every N new looks or weekly, unless recently dismissed. */
export function shouldRemindBackup(
  settings: Settings,
  looksCount: number,
): boolean {
  if (looksCount === 0) return false
  const now = Date.now()
  const dismissed = settings.backupReminderDismissedAt ?? 0
  if (now - dismissed < 3 * 24 * 60 * 60 * 1000) return false

  const atBackup = settings.looksCountAtBackup ?? 0
  if (looksCount - atBackup >= 3) return true

  const last = settings.lastBackupAt ?? 0
  if (last === 0 && looksCount >= 3) return true
  if (last > 0 && now - last >= 7 * 24 * 60 * 60 * 1000) return true

  return false
}

export async function markBackupDone(looksCount: number): Promise<Settings> {
  const settings = await getSettings()
  const next: Settings = {
    ...settings,
    lastBackupAt: Date.now(),
    looksCountAtBackup: looksCount,
    backupReminderDismissedAt: undefined,
  }
  await saveSettings(next)
  return next
}
