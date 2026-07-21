import exifr from 'exifr'

export type PhotoTakenAt = {
  date: string
  time: string
  takenAt: string
  source: 'exif' | 'file' | 'now'
}

export type PhotoGps = {
  latitude: number
  longitude: number
}

export type PhotoMeta = PhotoTakenAt & {
  gps?: PhotoGps
}

/** Main photo stored locally — aggressive enough for hundreds of looks. */
export const PHOTO_MAIN = { maxSide: 1024, quality: 0.72 } as const
/** List / archive / gist thumbs. */
export const PHOTO_THUMB = { maxSide: 360, quality: 0.7 } as const

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function fromDate(d: Date, source: PhotoTakenAt['source']): PhotoTakenAt {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    date,
    time,
    takenAt: `${date}T${time}:00`,
    source,
  }
}

async function extractTakenAt(file: File): Promise<PhotoTakenAt> {
  try {
    const tags = await exifr.parse(file, {
      pick: [
        'DateTimeOriginal',
        'CreateDate',
        'DateTimeDigitized',
        'ModifyDate',
      ],
    })
    const raw =
      tags?.DateTimeOriginal ??
      tags?.CreateDate ??
      tags?.DateTimeDigitized ??
      tags?.ModifyDate
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      return fromDate(raw, 'exif')
    }
  } catch {
    // fall through
  }

  if (file.lastModified) {
    return fromDate(new Date(file.lastModified), 'file')
  }

  return fromDate(new Date(), 'now')
}

async function extractGps(file: File): Promise<PhotoGps | undefined> {
  try {
    const gps = await exifr.gps(file)
    if (
      gps &&
      typeof gps.latitude === 'number' &&
      typeof gps.longitude === 'number' &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude)
    ) {
      return {
        latitude: gps.latitude,
        longitude: gps.longitude,
      }
    }
  } catch {
    // no GPS in file
  }
  return undefined
}

/** Read capture date/time + optional GPS from EXIF. */
export async function extractPhotoMeta(file: File): Promise<PhotoMeta> {
  const [taken, gps] = await Promise.all([
    extractTakenAt(file),
    extractGps(file),
  ])
  return { ...taken, gps }
}

/** @deprecated use extractPhotoMeta */
export async function extractPhotoTakenAt(file: File): Promise<PhotoTakenAt> {
  return extractTakenAt(file)
}

function asImageSource(source: Blob | File): Blob {
  return source
}

async function encodeBitmap(
  bitmap: ImageBitmap,
  maxSide: number,
  quality: number,
): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, w, h)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Compress failed'))),
      'image/jpeg',
      quality,
    )
  })
}

export async function compressImage(
  file: Blob | File,
  maxSide: number = PHOTO_MAIN.maxSide,
  quality: number = PHOTO_MAIN.quality,
): Promise<Blob> {
  const bitmap = await createImageBitmap(asImageSource(file))
  try {
    return await encodeBitmap(bitmap, maxSide, quality)
  } finally {
    bitmap.close()
  }
}

/** Decode once → main + thumb. Prefer this on save / import. */
export async function prepareLookImages(
  source: Blob | File,
): Promise<{ blob: Blob; thumbBlob: Blob }> {
  const bitmap = await createImageBitmap(asImageSource(source))
  try {
    const blob = await encodeBitmap(
      bitmap,
      PHOTO_MAIN.maxSide,
      PHOTO_MAIN.quality,
    )
    const thumbBlob = await encodeBitmap(
      bitmap,
      PHOTO_THUMB.maxSide,
      PHOTO_THUMB.quality,
    )
    return { blob, thumbBlob }
  } finally {
    bitmap.close()
  }
}

export function blobToObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob)
}

/** Stable object URLs keyed by cache key — survive IDB re-reads (new Blob refs). */
type LookObjectUrlEntry = { url: string; fingerprint: string }

const lookObjectUrlCache = new Map<string, LookObjectUrlEntry>()

function blobFingerprint(blob: Blob): string {
  return `${blob.size}:${blob.type}`
}

function cacheKey(lookId: string, variant: 'thumb' | 'full' = 'thumb'): string {
  return `${lookId}:${variant}`
}

/** Get or create a cached object URL. Revokes only when bytes change. */
export function getLookObjectUrl(
  id: string,
  blob: Blob,
  variant: 'thumb' | 'full' = 'thumb',
): string {
  const key = cacheKey(id, variant)
  const fingerprint = blobFingerprint(blob)
  const existing = lookObjectUrlCache.get(key)
  if (existing && existing.fingerprint === fingerprint) {
    return existing.url
  }
  if (existing) URL.revokeObjectURL(existing.url)
  const url = URL.createObjectURL(blob)
  lookObjectUrlCache.set(key, { url, fingerprint })
  return url
}

export function revokeLookObjectUrl(id: string): void {
  for (const variant of ['thumb', 'full'] as const) {
    const key = cacheKey(id, variant)
    const existing = lookObjectUrlCache.get(key)
    if (!existing) continue
    URL.revokeObjectURL(existing.url)
    lookObjectUrlCache.delete(key)
  }
}

/** Drop cached URLs for looks that are no longer in the library. */
export function pruneLookObjectUrls(keepIds: ReadonlySet<string>): void {
  for (const key of lookObjectUrlCache.keys()) {
    const lookId = key.split(':')[0]
    if (!keepIds.has(lookId)) {
      const existing = lookObjectUrlCache.get(key)
      if (existing) URL.revokeObjectURL(existing.url)
      lookObjectUrlCache.delete(key)
    }
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function base64ToBlob(base64: string, type = 'image/jpeg'): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`
  return `${(n / (1024 * 1024)).toFixed(1)} МБ`
}

export function isQuotaExceededError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { name?: string; message?: string; inner?: { name?: string } }
  if (err.name === 'QuotaExceededError') return true
  if (err.inner?.name === 'QuotaExceededError') return true
  const msg = (err.message ?? '').toLowerCase()
  return msg.includes('quota') || msg.includes('storage')
}

export const QUOTA_HINT =
  'Мало места на устройстве. Сожми старые фото в настройках, удали лишнее или сохрани копию и очисти архив.'
