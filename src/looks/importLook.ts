import { addLook, isStorageLow } from '../db'
import type { LocationSource, Look, Settings } from '../types'
import { fetchWeatherForDate, reverseGeocode } from '../weather/api'
import {
  extractPhotoMeta,
  isQuotaExceededError,
  prepareLookImages,
  QUOTA_HINT,
} from './media'

export type ImportLookResult =
  | { ok: true; look: Look }
  | { ok: false; error: string; fileName: string }

const BATCH_GAP_MS = 80

export type BuiltLook = {
  look: Look
  blob: Blob
  thumbBlob: Blob
}

/** Build a look from a gallery/camera file (EXIF → place → weather → compress). */
export async function buildLookFromFile(
  file: File,
  settings: Settings,
): Promise<BuiltLook> {
  const meta = await extractPhotoMeta(file)
  let placeName = settings.placeName
  let latitude = settings.latitude
  let longitude = settings.longitude
  let locationSource: LocationSource = 'settings'

  if (meta.gps) {
    locationSource = 'photo'
    latitude = meta.gps.latitude
    longitude = meta.gps.longitude
    try {
      const resolved = await reverseGeocode(latitude, longitude)
      placeName = resolved.name
      latitude = resolved.latitude
      longitude = resolved.longitude
    } catch {
      placeName = `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`
    }
  }

  const weather = await fetchWeatherForDate(
    latitude,
    longitude,
    meta.date,
    meta.time || undefined,
  )
  const { blob, thumbBlob } = await prepareLookImages(file)

  const look: Look = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    date: meta.date,
    time: meta.time || undefined,
    takenAt: meta.takenAt,
    weather,
    placeName,
    latitude,
    longitude,
    locationSource,
  }

  return { look, blob, thumbBlob }
}

export async function importLookFromFile(
  file: File,
  settings: Settings,
): Promise<ImportLookResult> {
  try {
    const { look, blob, thumbBlob } = await buildLookFromFile(file, settings)
    await addLook(look, { blob, thumbBlob })
    return { ok: true, look }
  } catch (e) {
    if (isQuotaExceededError(e)) {
      return {
        ok: false,
        error: QUOTA_HINT,
        fileName: file.name || 'фото',
      }
    }
    return {
      ok: false,
      error: (e as Error).message || 'ошибка',
      fileName: file.name || 'фото',
    }
  }
}

/** Import many files one-by-one with a short gap — never decode in parallel. */
export async function importLooksBatch(
  files: File[],
  settings: Settings,
  onProgress?: (done: number, total: number) => void,
): Promise<{ saved: number; failed: number; quotaHit: boolean }> {
  let saved = 0
  let failed = 0
  let quotaHit = false
  const total = files.length
  onProgress?.(0, total)

  if (await isStorageLow(Math.max(2 * 1024 * 1024, total * 150_000))) {
    // Soft warn — caller may show message; we still try
  }

  for (let i = 0; i < files.length; i++) {
    const result = await importLookFromFile(files[i], settings)
    if (result.ok) {
      saved += 1
    } else {
      failed += 1
      if (result.error === QUOTA_HINT) quotaHit = true
    }
    onProgress?.(i + 1, total)
    if (i < files.length - 1) {
      await new Promise((r) => setTimeout(r, BATCH_GAP_MS))
    }
  }
  return { saved, failed, quotaHit }
}
