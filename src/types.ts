export type Feedback = 'too_cold' | 'ok' | 'too_hot'

export type LocationSource = 'photo' | 'settings' | 'search' | 'geo'

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
  /** Where the look was worn — drives that look's weather snapshot */
  placeName: string
  latitude: number
  longitude: number
  locationSource?: LocationSource
  feedback?: Feedback
  feedbackNote?: string
}

export type LookExport = Omit<Look, 'photoBlob'> & {
  photoBase64: string
}

export type Settings = Place

export type Tab = 'today' | 'add' | 'archive' | 'settings'

export type RankedLook = {
  look: Look
  /** Weather distance — lower is better. Not a date. */
  score: number
  matchPercent: number
  reason: string
  effectiveWarmth: number
}
