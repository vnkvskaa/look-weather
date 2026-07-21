import Dexie, { type EntityTable } from 'dexie'
import type { Look, Settings } from './types'

const DEFAULT_SETTINGS: Settings = {
  placeName: 'Москва',
  latitude: 55.7558,
  longitude: 37.6173,
  cityConfirmed: false,
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
  if (row?.value) {
    const saved = row.value as Settings
    // Existing installs already chose a city — skip onboarding.
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      cityConfirmed: saved.cityConfirmed ?? true,
    }
  }
  return { ...DEFAULT_SETTINGS }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await db.meta.put({ key: 'settings', value: settings })
}

export async function listLooks(): Promise<Look[]> {
  const rows = await db.looks.orderBy('date').reverse().toArray()
  const settings = await getSettings()
  return rows.map((look) => ({
    ...look,
    placeName: look.placeName || settings.placeName,
    latitude: look.latitude ?? settings.latitude,
    longitude: look.longitude ?? settings.longitude,
    locationSource: look.locationSource ?? 'settings',
  }))
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

export async function updateLook(
  id: string,
  patch: Partial<Omit<Look, 'id' | 'photoBlob'>>,
): Promise<void> {
  await db.looks.update(id, patch)
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
