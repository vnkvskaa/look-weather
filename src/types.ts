export type Feedback = 'too_cold' | 'ok' | 'too_hot'

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

export type Look = {
  id: string
  createdAt: number
  date: string
  /** Local time from photo EXIF, HH:mm */
  time?: string
  /** ISO-ish local timestamp from photo metadata */
  takenAt?: string
  note?: string
  photoBlob: Blob
  weather: WeatherProfile
  feedback?: Feedback
  feedbackNote?: string
}

export type LookExport = Omit<Look, 'photoBlob'> & {
  photoBase64: string
}

export type Settings = {
  placeName: string
  latitude: number
  longitude: number
}

export type Tab = 'today' | 'add' | 'archive' | 'settings'

export type RankedLook = {
  look: Look
  score: number
  reason: string
  effectiveWarmth: number
}
