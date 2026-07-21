/** Comfort in this outfit that day. Symmetric around ok. */
export type Feedback = 'cold' | 'cool' | 'ok' | 'warm' | 'hot'

/** Pre-scale values still present in older backups / IndexedDB. */
export type LegacyFeedback = 'too_cold' | 'too_hot'

export const FEEDBACK_STEPS: Array<{ id: Feedback; label: string }> = [
  { id: 'cold', label: 'холодно' },
  { id: 'cool', label: 'прохладно' },
  { id: 'ok', label: 'норм' },
  { id: 'warm', label: 'тепловато' },
  { id: 'hot', label: 'жарко' },
]

export const FEEDBACK_LABEL: Record<Feedback, string> = {
  cold: 'холодно',
  cool: 'прохладно',
  ok: 'норм',
  warm: 'тепловато',
  hot: 'жарко',
}

/**
 * Map any stored feedback (old 3-way or new 5-way) to the current scale.
 * Returns undefined for missing / unknown values.
 */
export function normalizeFeedback(raw: unknown): Feedback | undefined {
  if (raw === 'too_cold' || raw === 'cold') return 'cold'
  if (raw === 'cool') return 'cool'
  if (raw === 'ok') return 'ok'
  if (raw === 'warm') return 'warm'
  if (raw === 'too_hot' || raw === 'hot') return 'hot'
  if (raw === -2 || raw === '-2') return 'cold'
  if (raw === -1 || raw === '-1') return 'cool'
  if (raw === 0 || raw === '0') return 'ok'
  if (raw === 1 || raw === '1') return 'warm'
  if (raw === 2 || raw === '2') return 'hot'
  return undefined
}

export type LocationSource = 'photo' | 'settings' | 'search' | 'geo'

/** Legacy wardrobe chips — kept for old backups / IndexedDB only; never shown in UI. */
export type ItemTag = 'верх' | 'низ' | 'слой' | 'обувь' | 'другое'

export type Place = {
  placeName: string
  latitude: number
  longitude: number
}

export type WeatherProfile = {
  date: string
  feelsLike: number
  tempMean: number
  windMs: number
  humidity: number
  precipMm: number
  precipProb: number
  cloudCover: number
}

/** Look metadata — no photo bytes (those live in the `photos` table). */
export type Look = {
  id: string
  createdAt: number
  date: string
  /** Local time from photo EXIF, HH:mm */
  time?: string
  /** ISO-ish local timestamp from photo metadata */
  takenAt?: string
  note?: string
  /** Legacy — never collected in UI; preserved on import only */
  items?: ItemTag[]
  weather: WeatherProfile
  /** Where the look was worn — drives that look's weather snapshot */
  placeName: string
  latitude: number
  longitude: number
  locationSource?: LocationSource
  feedback?: Feedback
  /** Optional short comfort note */
  feedbackNote?: string
  /** Starred look — mild boost when weather-similar */
  favorite?: boolean
}

/** Photo row keyed by look id. */
export type LookPhoto = {
  lookId: string
  blob: Blob
  thumbBlob?: Blob
}

export type LookExport = Omit<Look, never> & {
  photoBase64?: string
  /** thumb — compact file export; full — full photos in file export */
  photoKind?: 'none' | 'thumb' | 'full'
}

export type Settings = Place & {
  /** User confirmed city on onboarding / settings */
  cityConfirmed?: boolean
  /** Permanent home city — kept when travel override is active */
  homePlace?: Place
  /** Temporary travel city; when set, placeName/lat/lon follow it */
  travelPlace?: Place
  /** GitHub PAT — only in IndexedDB, never in public repo or shared backup JSON */
  githubToken?: string
  /**
   * Private backup repo full name, e.g. `user/look-weather-data`.
   * New saves go here (photos as separate files).
   */
  githubRepoFullName?: string
  /** Legacy private gist id — restore only */
  githubGistId?: string
  /**
   * Auto-upload to the private backup repo after look changes.
   * Default ON when a token is saved (`undefined` / missing ≈ on).
   */
  githubAutoBackup?: boolean
  /** Last successful GitHub / file backup timestamp */
  lastBackupAt?: number
  /** Looks count at last backup — for soft «пора бэкапнуть» */
  looksCountAtBackup?: number
  /** When user dismissed backup reminder */
  backupReminderDismissedAt?: number
  /** Last successful «проверить» / token+copy ping */
  githubBackupVerifiedAt?: number
}

export type Tab = 'today' | 'add' | 'archive' | 'settings'

export type RankedLook = {
  look: Look
  /** Weather distance — lower is better. Not a date. */
  score: number
  matchPercent: number
  reason: string
  effectiveWarmth: number
}

/** Same calendar day — one card in lists / recommendations. */
export type DayGroup = {
  date: string
  looks: Look[]
  /** Prefer time near outing / most complete place */
  primary: Look
}

export type RankedDayGroup = DayGroup & {
  score: number
  matchPercent: number
  reason: string
  effectiveWarmth: number
  best: RankedLook
}
