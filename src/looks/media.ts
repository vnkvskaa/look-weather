import exifr from 'exifr'

export type PhotoTakenAt = {
  date: string
  time: string
  takenAt: string
  source: 'exif' | 'file' | 'now'
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

/** Read capture date/time from EXIF; fall back to file mtime, then now. */
export async function extractPhotoTakenAt(file: File): Promise<PhotoTakenAt> {
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
    // ignore and fall through
  }

  if (file.lastModified) {
    return fromDate(new Date(file.lastModified), 'file')
  }

  return fromDate(new Date(), 'now')
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
