import { listLooks, replaceAllLooks, getSettings, saveSettings } from '../db'
import type { Look, LookExport, Settings } from '../types'
import { base64ToBlob, blobToBase64 } from './media'

export type BackupPayload = {
  version: 1
  exportedAt: string
  settings: Settings
  looks: LookExport[]
}

export async function buildBackup(): Promise<BackupPayload> {
  const [looks, settings] = await Promise.all([listLooks(), getSettings()])
  const exported: LookExport[] = []
  for (const look of looks) {
    const { photoBlob, ...rest } = look
    exported.push({
      ...rest,
      photoBase64: await blobToBase64(photoBlob),
    })
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
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

export async function importBackupFile(file: File): Promise<number> {
  const text = await file.text()
  const data = JSON.parse(text) as BackupPayload
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

  await replaceAllLooks(looks)
  if (data.settings) await saveSettings(data.settings)
  return looks.length
}
