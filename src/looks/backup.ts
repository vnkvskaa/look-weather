import {
  listLooksMeta,
  mergeLooks,
  upsertLookMeta,
  upsertLookThumb,
  getSettings,
  saveSettings,
  getLookPhoto,
  getLookThumbBlob,
  getLookFullBlob,
  countLooks,
} from '../db'
import type { Look, LookExport, Place, Settings } from '../types'
import { normalizeFeedback } from '../types'
import {
  base64ToBlob,
  blobToBase64,
  compressCloudThumb,
  prepareLookImages,
} from './media'

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

/** Settings fields safe to put in a shareable / cloud JSON (no PAT). */
export function settingsForBackup(settings: Settings): Settings {
  return {
    placeName: settings.placeName,
    latitude: settings.latitude,
    longitude: settings.longitude,
    cityConfirmed: settings.cityConfirmed,
    homePlace: placeForBackup(settings.homePlace),
    travelPlace: placeForBackup(settings.travelPlace),
    githubRepoFullName: settings.githubRepoFullName,
    // Do not carry legacy gist ids into new backups
    githubAutoBackup: settings.githubAutoBackup,
    lastBackupAt: settings.lastBackupAt,
    looksCountAtBackup: settings.looksCountAtBackup,
    backupReminderDismissedAt: settings.backupReminderDismissedAt,
    githubBackupVerifiedAt: settings.githubBackupVerifiedAt,
    githubRepoTokenValidatedAt: settings.githubRepoTokenValidatedAt,
    backupSetupStep: settings.backupSetupStep,
  }
}

export type ImportResult = {
  imported: number
  total: number
}

export type BackupBuildOptions = {
  /**
   * none — meta only (GitHub default).
   * thumb — tiny previews (optional GitHub / everyday file).
   * full — full photos (file export only).
   */
  photo?: 'none' | 'thumb' | 'full'
  /** Recompress thumbs for cloud size (GitHub optional previews). */
  cloudThumb?: boolean
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
    if (photoKind === 'none') {
      exported.push({ ...look, photoKind: 'none' })
      await new Promise((r) => setTimeout(r, 0))
      continue
    }

    let photoBlob: Blob | null = null
    if (photoKind === 'thumb') {
      photoBlob = await getLookThumbBlob(look.id)
      if (!photoBlob) {
        const row = await getLookPhoto(look.id)
        photoBlob = row?.blob ?? row?.thumbBlob ?? null
      }
      if (photoBlob && options.cloudThumb) {
        photoBlob = await compressCloudThumb(photoBlob)
      }
    } else {
      photoBlob = await getLookFullBlob(look.id)
      if (!photoBlob) {
        const row = await getLookPhoto(look.id)
        photoBlob = row?.blob ?? row?.thumbBlob ?? null
      }
    }

    if (!photoBlob) {
      // Keep meta even without a photo (placeholder on restore)
      exported.push({ ...look, photoKind: 'none' })
      await new Promise((r) => setTimeout(r, 0))
      continue
    }

    exported.push({
      ...look,
      photoBase64: await blobToBase64(photoBlob),
      photoKind,
    })
    await new Promise((r) => setTimeout(r, 0))
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: settingsForBackup(settings),
    looks: exported,
  }
}

/** UTF-8 byte length of a JSON backup (close to upload size). */
export function backupJsonBytes(payload: BackupPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length
}

export async function estimateBackupBytes(
  options: BackupBuildOptions = {},
): Promise<number> {
  return backupJsonBytes(await buildBackup(options))
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

/** Compact file copy (device thumbs) — for Файлы, not GitHub. */
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

  const withPhotos: Array<Look & { photoBlob: Blob; thumbBlob?: Blob }> = []
  let metaOnlyCount = 0

  for (const item of data.looks) {
    const { photoBase64, photoKind, ...rest } = item
    const meta: Look = {
      ...rest,
      feedback: normalizeFeedback(rest.feedback),
      favorite: rest.favorite === true ? true : undefined,
    }

    if (!photoBase64) {
      await upsertLookMeta(meta)
      metaOnlyCount += 1
      await new Promise((r) => setTimeout(r, 0))
      continue
    }

    const raw = base64ToBlob(photoBase64)
    const existing = await getLookPhoto(meta.id)

    if (existing?.blob && photoKind === 'thumb') {
      // Keep local full photo; refresh list thumb from cloud preview
      await upsertLookMeta(meta)
      try {
        await upsertLookThumb(meta.id, raw)
      } catch {
        // leave existing photo
      }
      metaOnlyCount += 1
      await new Promise((r) => setTimeout(r, 0))
      continue
    }

    let photoBlob = raw
    let thumbBlob: Blob | undefined
    try {
      const prepared = await prepareLookImages(raw)
      photoBlob = prepared.blob
      thumbBlob = prepared.thumbBlob
    } catch {
      thumbBlob = raw
    }
    withPhotos.push({
      ...meta,
      photoBlob,
      thumbBlob,
    })
    await new Promise((r) => setTimeout(r, 0))
  }

  let imported = metaOnlyCount
  if (withPhotos.length > 0) {
    const result = await mergeLooks(withPhotos)
    imported += result.imported
  }

  const current = await getSettings()
  const total = await countLooks()
  if (data.settings) {
    const fromBackup = settingsForBackup(data.settings)
    await saveSettings({
      ...current,
      ...fromBackup,
      githubToken: current.githubToken,
      githubRepoFullName:
        data.settings.githubRepoFullName || current.githubRepoFullName,
      // Ignore imported gist ids — new copies use the private repo only
      githubGistId: current.githubGistId,
      githubRepoTokenValidatedAt: current.githubRepoTokenValidatedAt,
      backupSetupStep: current.backupSetupStep,
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
