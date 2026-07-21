import Dexie, { type EntityTable } from 'dexie'
import type { Look, Settings } from './types'

const DEFAULT_SETTINGS: Settings = {
  placeName: 'Москва',
  latitude: 55.7558,
  longitude: 37.6173,
}

class LookWeatherDB extends Dexie {
  looks!: EntityTable<Look, 'id'>
  meta!: EntityTable<{ key: string; value: unknown }, 'key'>

  constructor() {
    super('look-weather')
    this.version(1).stores({
      looks: 'id, date, createdAt',
      meta: 'key',
    })
  }
}

export const db = new LookWeatherDB()

export async function getSettings(): Promise<Settings> {
  const row = await db.meta.get('settings')
  if (row?.value) return row.value as Settings
  return DEFAULT_SETTINGS
}

export async function saveSettings(settings: Settings): Promise<void> {
  await db.meta.put({ key: 'settings', value: settings })
}

export async function listLooks(): Promise<Look[]> {
  return db.looks.orderBy('date').reverse().toArray()
}

export async function addLook(look: Look): Promise<void> {
  await db.looks.put(look)
}

export async function updateLookFeedback(
  id: string,
  feedback: Look['feedback'],
  feedbackNote?: string,
): Promise<void> {
  await db.looks.update(id, { feedback, feedbackNote })
}

export async function deleteLook(id: string): Promise<void> {
  await db.looks.delete(id)
}

export async function replaceAllLooks(looks: Look[]): Promise<void> {
  await db.transaction('rw', db.looks, async () => {
    await db.looks.clear()
    await db.looks.bulkPut(looks)
  })
}
