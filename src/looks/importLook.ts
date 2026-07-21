import { addLook } from '../db'
import type { LocationSource, Look, Settings } from '../types'
import { fetchWeatherForDate, reverseGeocode } from '../weather/api'
import { compressImage, extractPhotoMeta } from './media'

export type ImportLookResult =
  | { ok: true; look: Look }
  | { ok: false; error: string; fileName: string }

/** Build a look from a gallery/camera file (EXIF → place → weather → compress). */
export async function buildLookFromFile(
  file: File,
  settings: Settings,
): Promise<Look> {
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
  const photoBlob = await compressImage(file)

  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    date: meta.date,
    time: meta.time || undefined,
    takenAt: meta.takenAt,
    photoBlob,
    weather,
    placeName,
    latitude,
    longitude,
    locationSource,
  }
}

export async function importLookFromFile(
  file: File,
  settings: Settings,
): Promise<ImportLookResult> {
  try {
    const look = await buildLookFromFile(file, settings)
    await addLook(look)
    return { ok: true, look }
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message || 'ошибка',
      fileName: file.name || 'фото',
    }
  }
}

/** Import many files; failures are skipped so the batch continues. */
export async function importLooksBatch(
  files: File[],
  settings: Settings,
  onProgress?: (done: number, total: number) => void,
): Promise<{ saved: number; failed: number }> {
  let saved = 0
  let failed = 0
  const total = files.length
  onProgress?.(0, total)
  for (let i = 0; i < files.length; i++) {
    const result = await importLookFromFile(files[i], settings)
    if (result.ok) saved += 1
    else failed += 1
    onProgress?.(i + 1, total)
  }
  return { saved, failed }
}
