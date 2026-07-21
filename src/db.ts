import Dexie, { type EntityTable } from 'dexie'
import type { Look, LookPhoto, Settings } from './types'
import { normalizeFeedback } from './types'
import {
  prepareLookImages,
  PHOTO_MAIN,
  PHOTO_THUMB,
  compressImage,
} from './looks/media'

const DEFAULT_SETTINGS: Settings = {
  placeName: 'Москва',
  latitude: 55.7558,
  longitude: 37.6173,
  cityConfirmed: false,
}

/** Legacy v1 row — photoBlob lived on the look. */
type LegacyLookRow = Look & { photoBlob?: Blob }

class LookWeatherDB extends Dexie {
  looks!: EntityTable<Look, 'id'>
  photos!: EntityTable<LookPhoto, 'lookId'>
  meta!: EntityTable<{ key: string; value: unknown }, 'key'>

  constructor() {
    super('look-weather')
    this.version(1).stores({
      looks: 'id, date, createdAt',
      meta: 'key',
    })
    this.version(2)
      .stores({
        looks: 'id, date, createdAt',
        photos: 'lookId',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const looksTable = tx.table('looks')
        const photosTable = tx.table('photos')
        const rows = (await looksTable.toArray()) as LegacyLookRow[]
        for (const row of rows) {
          const blob = row.photoBlob
          if (blob instanceof Blob) {
            await photosTable.put({ lookId: row.id, blob })
          }
          const { photoBlob: _drop, ...meta } = row
          await looksTable.put(meta as Look)
        }
      })
  }
}

export const db = new LookWeatherDB()

let migrateReady: Promise<void> | null = null

/** Ensure schema upgrade + lazy thumbs for migrated rows. */
export function ensureDbReady(): Promise<void> {
  if (!migrateReady) {
    migrateReady = (async () => {
      await db.open()
    })().catch((e) => {
      migrateReady = null
      throw e
    })
  }
  return migrateReady
}

export async function getSettings(): Promise<Settings> {
  await ensureDbReady()
  const row = await db.meta.get('settings')
  if (row?.value) {
    const saved = row.value as Settings
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      cityConfirmed: saved.cityConfirmed ?? true,
    }
  }
  return { ...DEFAULT_SETTINGS }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ensureDbReady()
  await db.meta.put({ key: 'settings', value: settings })
}

function normalizeLook(look: Look, settings: Settings): Look {
  const feedback = normalizeFeedback(look.feedback)
  return {
    id: look.id,
    createdAt: look.createdAt,
    date: look.date,
    time: look.time,
    takenAt: look.takenAt,
    note: look.note,
    items: look.items,
    weather: look.weather,
    placeName: look.placeName || settings.placeName,
    latitude: look.latitude ?? settings.latitude,
    longitude: look.longitude ?? settings.longitude,
    locationSource: look.locationSource ?? 'settings',
    feedback,
    feedbackNote: look.feedbackNote,
    favorite: look.favorite === true ? true : undefined,
  }
}

/** Strip accidental blob fields if present on a row. */
function metaOnly(row: Look & { photoBlob?: unknown }): Look {
  const { photoBlob: _b, ...rest } = row as Look & { photoBlob?: unknown }
  return rest
}

/** Metadata only — safe to keep all rows in React state. */
export async function listLooksMeta(): Promise<Look[]> {
  await ensureDbReady()
  const rows = await db.looks.orderBy('date').reverse().toArray()
  const settings = await getSettings()
  return rows.map((look) => normalizeLook(metaOnly(look), settings))
}

/** @deprecated alias — returns meta only (no blobs). */
export async function listLooks(): Promise<Look[]> {
  return listLooksMeta()
}

export async function countLooks(): Promise<number> {
  await ensureDbReady()
  return db.looks.count()
}

export async function getLookPhoto(lookId: string): Promise<LookPhoto | undefined> {
  await ensureDbReady()
  return db.photos.get(lookId)
}

/**
 * Prefer thumb for lists. Lazily creates thumb from full if missing.
 */
export async function getLookThumbBlob(lookId: string): Promise<Blob | null> {
  const photo = await getLookPhoto(lookId)
  if (!photo) return null
  if (photo.thumbBlob) return photo.thumbBlob
  if (!photo.blob) return null
  try {
    const thumbBlob = await compressImage(
      photo.blob,
      PHOTO_THUMB.maxSide,
      PHOTO_THUMB.quality,
    )
    await db.photos.update(lookId, { thumbBlob })
    return thumbBlob
  } catch {
    return photo.blob
  }
}

export async function getLookFullBlob(lookId: string): Promise<Blob | null> {
  const photo = await getLookPhoto(lookId)
  return photo?.blob ?? photo?.thumbBlob ?? null
}

export async function addLook(
  look: Look,
  images: { blob: Blob; thumbBlob?: Blob },
): Promise<void> {
  await ensureDbReady()
  const thumbBlob =
    images.thumbBlob ??
    (await compressImage(
      images.blob,
      PHOTO_THUMB.maxSide,
      PHOTO_THUMB.quality,
    ))
  await db.transaction('rw', db.looks, db.photos, async () => {
    await db.looks.put(metaOnly(look))
    await db.photos.put({
      lookId: look.id,
      blob: images.blob,
      thumbBlob,
    })
  })
}

export async function updateLookFeedback(
  id: string,
  feedback: Look['feedback'],
  feedbackNote?: string,
): Promise<void> {
  await ensureDbReady()
  await db.looks.update(id, { feedback, feedbackNote })
}

export async function updateLook(
  id: string,
  patch: Partial<Omit<Look, 'id'>>,
): Promise<void> {
  await ensureDbReady()
  await db.looks.update(id, patch)
}

export async function deleteLook(id: string): Promise<void> {
  await ensureDbReady()
  await db.transaction('rw', db.looks, db.photos, async () => {
    await db.looks.delete(id)
    await db.photos.delete(id)
  })
}

export async function replaceAllLooks(
  looks: Array<Look & { photoBlob: Blob; thumbBlob?: Blob }>,
): Promise<void> {
  await ensureDbReady()
  await db.transaction('rw', db.looks, db.photos, async () => {
    await db.looks.clear()
    await db.photos.clear()
    for (const look of looks) {
      const { photoBlob, thumbBlob, ...meta } = look
      await db.looks.put(metaOnly(meta))
      await db.photos.put({
        lookId: meta.id,
        blob: photoBlob,
        thumbBlob,
      })
    }
  })
}

/**
 * Upsert looks by id — keeps local-only looks, overwrites matching ids.
 */
export async function mergeLooks(
  looks: Array<Look & { photoBlob: Blob; thumbBlob?: Blob }>,
): Promise<{ imported: number; total: number }> {
  await ensureDbReady()
  // Compress outside the IDB transaction — canvas work can be slow.
  const rows: Array<{ meta: Look; blob: Blob; thumbBlob?: Blob }> = []
  for (const look of looks) {
    const { photoBlob, thumbBlob, ...meta } = look
    let thumb = thumbBlob
    if (!thumb && photoBlob) {
      try {
        thumb = await compressImage(
          photoBlob,
          PHOTO_THUMB.maxSide,
          PHOTO_THUMB.quality,
        )
      } catch {
        thumb = undefined
      }
    }
    rows.push({ meta: metaOnly(meta), blob: photoBlob, thumbBlob: thumb })
  }
  await db.transaction('rw', db.looks, db.photos, async () => {
    for (const row of rows) {
      await db.looks.put(row.meta)
      await db.photos.put({
        lookId: row.meta.id,
        blob: row.blob,
        thumbBlob: row.thumbBlob,
      })
    }
  })
  const total = await db.looks.count()
  return { imported: looks.length, total }
}

export type StorageEstimate = {
  usage: number
  quota: number
  /** 0–1, or null if unknown */
  ratio: number | null
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return {
      usage,
      quota,
      ratio: quota > 0 ? usage / quota : null,
    }
  } catch {
    return null
  }
}

/** Rough free-space check before a batch import. */
export async function isStorageLow(
  neededBytes = 2 * 1024 * 1024,
): Promise<boolean> {
  const est = await estimateStorage()
  if (!est || est.quota <= 0) return false
  if (est.ratio !== null && est.ratio >= 0.88) return true
  return est.quota - est.usage < neededBytes
}

export type RecompressResult = {
  done: number
  failed: number
}

/**
 * Re-encode every stored full photo to current main/thumb limits.
 * Sequential — safe for large archives.
 */
export async function recompressAllPhotos(
  onProgress?: (done: number, total: number) => void,
): Promise<RecompressResult> {
  await ensureDbReady()
  const keys = await db.photos.toCollection().primaryKeys()
  const total = keys.length
  let done = 0
  let failed = 0
  onProgress?.(0, total)

  for (const lookId of keys) {
    try {
      const row = await db.photos.get(lookId)
      if (!row?.blob) {
        failed += 1
      } else {
        const prepared = await prepareLookImages(row.blob)
        await db.photos.put({
          lookId: String(lookId),
          blob: prepared.blob,
          thumbBlob: prepared.thumbBlob,
        })
        done += 1
      }
    } catch {
      failed += 1
    }
    onProgress?.(done + failed, total)
    await new Promise((r) => setTimeout(r, 30))
  }

  return { done, failed }
}

export { PHOTO_MAIN, PHOTO_THUMB }
