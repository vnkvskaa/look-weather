import {
  listLooksMeta,
  mergeLooks,
  getSettings,
  saveSettings,
  getLookPhoto,
  getLookThumbBlob,
  getLookFullBlob,
  countLooks,
} from '../db'
import type { Look, LookExport, Place, Settings } from '../types'
import { normalizeFeedback } from '../types'
import { base64ToBlob, blobToBase64, prepareLookImages } from './media'

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
    githubBackupVerifiedAt: settings.githubBackupVerifiedAt,
  }
}

export type ImportResult = {
  imported: number
  total: number
}

export type BackupBuildOptions = {
  /**
   * thumbs — compact (gist / auto). full — larger file export.
   * Default thumbs to avoid OOM / gist limits.
   */
  photo?: 'thumb' | 'full'
}

/**
 * Build backup one look at a time — never loads all photo blobs into RAM.
 */
export async function buildBackup(
  options: BackupBuildOptions = {},
): Promise<BackupPayload> {
  const photoKind = options.photo ?? 'thumb'
  const [looks, settings] = await Promise.all([
    listLooksMeta(),
    getSettings(),
  ])
  const exported: LookExport[] = []

  for (const look of looks) {
    let photoBlob: Blob | null = null
    if (photoKind === 'thumb') {
      photoBlob = await getLookThumbBlob(look.id)
    } else {
      photoBlob = await getLookFullBlob(look.id)
    }
    if (!photoBlob) {
      const row = await getLookPhoto(look.id)
      photoBlob = row?.blob ?? row?.thumbBlob ?? null
    }
    if (!photoBlob) continue

    exported.push({
      ...look,
      photoBase64: await blobToBase64(photoBlob),
      photoKind,
    })
    // Yield so UI stays responsive on large archives
    await new Promise((r) => setTimeout(r, 0))
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: settingsForBackup(settings),
    looks: exported,
  }
}

async function downloadJson(text: string, filename: string): Promise<void> {
  const blob = new Blob([text], { type: 'application/json' })
  const file = new File([blob], filename, { type: 'application/json' })
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: 'look. backup',
      text: 'Копия луков — сохрани в Файлы',
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

/** Compact copy (thumbs) — safe for cloud / everyday. */
export async function shareOrDownloadBackup(): Promise<void> {
  const payload = await buildBackup({ photo: 'thumb' })
  const text = JSON.stringify(payload)
  const filename = `look-weather-${payload.exportedAt.slice(0, 10)}.json`
  await downloadJson(text, filename)
}

/**
 * Full-resolution copy. Can be large — caller should warn the user first.
 */
export async function shareOrDownloadFullBackup(): Promise<void> {
  const payload = await buildBackup({ photo: 'full' })
  const text = JSON.stringify(payload)
  const filename = `look-weather-full-${payload.exportedAt.slice(0, 10)}.json`
  await downloadJson(text, filename)
}

export async function importBackupPayload(
  data: BackupPayload,
): Promise<ImportResult> {
  if (data.version !== 1 || !Array.isArray(data.looks)) {
    throw new Error('Неверный формат бэкапа')
  }

  const looks: Array<Look & { photoBlob: Blob; thumbBlob?: Blob }> = []

  for (const item of data.looks) {
    const { photoBase64, photoKind: _kind, ...rest } = item
    const raw = base64ToBlob(photoBase64)
    let photoBlob = raw
    let thumbBlob: Blob | undefined
    try {
      const prepared = await prepareLookImages(raw)
      photoBlob = prepared.blob
      thumbBlob = prepared.thumbBlob
    } catch {
      thumbBlob = raw
    }
    looks.push({
      ...rest,
      feedback: normalizeFeedback(rest.feedback),
      favorite: rest.favorite === true ? true : undefined,
      photoBlob,
      thumbBlob,
    })
    await new Promise((r) => setTimeout(r, 0))
  }

  const current = await getSettings()
  const { imported, total } = await mergeLooks(looks)
  if (data.settings) {
    const fromBackup = settingsForBackup(data.settings)
    await saveSettings({
      ...current,
      ...fromBackup,
      githubToken: current.githubToken,
      githubGistId: data.settings.githubGistId || current.githubGistId,
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

export async function markBackupDone(looksCount?: number): Promise<Settings> {
  const settings = await getSettings()
  const count = looksCount ?? (await countLooks())
  const next: Settings = {
    ...settings,
    lastBackupAt: Date.now(),
    looksCountAtBackup: count,
    backupReminderDismissedAt: undefined,
  }
  await saveSettings(next)
  return next
}
