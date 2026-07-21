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

export async function compressImage(
  file: File,
  maxSide = 1280,
  quality = 0.82,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Compress failed'))),
      'image/jpeg',
      quality,
    )
  })
  return blob
}

export function blobToObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob)
}

/** Stable object URLs keyed by look id — survive IDB re-reads (new Blob refs). */
type LookObjectUrlEntry = { url: string; fingerprint: string }

const lookObjectUrlCache = new Map<string, LookObjectUrlEntry>()

function blobFingerprint(blob: Blob): string {
  return `${blob.size}:${blob.type}`
}

/** Get or create a cached object URL for a look. Revokes only when bytes change. */
export function getLookObjectUrl(id: string, blob: Blob): string {
  const fingerprint = blobFingerprint(blob)
  const existing = lookObjectUrlCache.get(id)
  if (existing && existing.fingerprint === fingerprint) {
    return existing.url
  }
  if (existing) URL.revokeObjectURL(existing.url)
  const url = URL.createObjectURL(blob)
  lookObjectUrlCache.set(id, { url, fingerprint })
  return url
}

export function revokeLookObjectUrl(id: string): void {
  const existing = lookObjectUrlCache.get(id)
  if (!existing) return
  URL.revokeObjectURL(existing.url)
  lookObjectUrlCache.delete(id)
}

/** Drop cached URLs for looks that are no longer in the library. */
export function pruneLookObjectUrls(keepIds: ReadonlySet<string>): void {
  for (const id of lookObjectUrlCache.keys()) {
    if (!keepIds.has(id)) revokeLookObjectUrl(id)
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
