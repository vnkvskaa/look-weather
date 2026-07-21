import type { WeatherProfile } from '../types'

type DailyBlock = {
  time: string[]
  temperature_2m_mean?: number[]
  apparent_temperature_mean?: number[]
  apparent_temperature_max?: number[]
  wind_speed_10m_max?: number[]
  precipitation_sum?: number[]
  precipitation_probability_max?: number[]
  cloud_cover_mean?: number[]
  relative_humidity_2m_mean?: number[]
}

type ForecastResponse = {
  daily: DailyBlock
}

type ArchiveResponse = {
  daily: DailyBlock
}

type GeocodeResult = {
  results?: Array<{
    name: string
    country?: string
    latitude: number
    longitude: number
    admin1?: string
  }>
}

function pick(arr: number[] | undefined, i: number, fallback = 0): number {
  if (!arr || arr[i] == null || Number.isNaN(arr[i])) return fallback
  return arr[i]
}

function toProfile(daily: DailyBlock, index: number): WeatherProfile {
  const feelsMean = daily.apparent_temperature_mean?.[index]
  const feels =
    feelsMean != null && !Number.isNaN(feelsMean)
      ? feelsMean
      : pick(daily.apparent_temperature_max, index, 0)
  return {
    date: daily.time[index],
    feelsLike: Math.round(feels * 10) / 10,
    tempMean: Math.round(pick(daily.temperature_2m_mean, index, feels) * 10) / 10,
    windMs: Math.round(pick(daily.wind_speed_10m_max, index) * 10) / 10,
    humidity: Math.round(pick(daily.relative_humidity_2m_mean, index, 60)),
    precipMm: Math.round(pick(daily.precipitation_sum, index) * 10) / 10,
    precipProb: Math.round(pick(daily.precipitation_probability_max, index)),
    cloudCover: Math.round(pick(daily.cloud_cover_mean, index, 50)),
  }
}

const DAILY =
  'temperature_2m_mean,apparent_temperature_mean,apparent_temperature_max,wind_speed_10m_max,precipitation_sum,precipitation_probability_max,cloud_cover_mean,relative_humidity_2m_mean'

export async function searchPlaces(query: string) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', query)
  url.searchParams.set('count', '6')
  url.searchParams.set('language', 'ru')
  url.searchParams.set('format', 'json')
  const res = await fetch(url)
  if (!res.ok) throw new Error('Не удалось найти город')
  const data = (await res.json()) as GeocodeResult
  return (data.results ?? []).map((r) => ({
    name: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
  }))
}

export async function fetchWeatherForDate(
  latitude: number,
  longitude: number,
  date: string,
): Promise<WeatherProfile> {
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const target = new Date(date + 'T12:00:00')
  const diffDays = Math.floor(
    (target.getTime() - new Date(todayStr + 'T12:00:00').getTime()) /
      (1000 * 60 * 60 * 24),
  )

  // Forecast covers ~16 days ahead and a bit of recent past via forecast API;
  // older days go to archive.
  if (diffDays >= -5 && diffDays <= 14) {
    return fetchForecastDay(latitude, longitude, date)
  }
  return fetchArchiveDay(latitude, longitude, date)
}

async function fetchForecastDay(
  latitude: number,
  longitude: number,
  date: string,
): Promise<WeatherProfile> {
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('daily', DAILY)
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('forecast_days', '16')
  url.searchParams.set('past_days', '5')
  url.searchParams.set('wind_speed_unit', 'ms')

  const res = await fetch(url)
  if (!res.ok) throw new Error('Не удалось загрузить прогноз')
  const data = (await res.json()) as ForecastResponse
  const idx = data.daily.time.indexOf(date)
  if (idx < 0) {
    // fall back to archive if date missing from window
    return fetchArchiveDay(latitude, longitude, date)
  }
  return toProfile(data.daily, idx)
}

async function fetchArchiveDay(
  latitude: number,
  longitude: number,
  date: string,
): Promise<WeatherProfile> {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('start_date', date)
  url.searchParams.set('end_date', date)
  url.searchParams.set(
    'daily',
    'temperature_2m_mean,apparent_temperature_mean,apparent_temperature_max,wind_speed_10m_max,precipitation_sum,cloud_cover_mean,relative_humidity_2m_mean',
  )
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('wind_speed_unit', 'ms')

  const res = await fetch(url)
  if (!res.ok) throw new Error('Не удалось загрузить архив погоды')
  const data = (await res.json()) as ArchiveResponse
  if (!data.daily?.time?.length) throw new Error('Нет данных за этот день')
  const profile = toProfile(data.daily, 0)
  profile.precipProb = profile.precipMm > 0.2 ? 80 : 10
  return profile
}

export function weatherLabel(p: WeatherProfile): string {
  const parts: string[] = []

  if (p.precipMm >= 2 || p.precipProb >= 60) parts.push('дождь')
  else if (p.precipMm >= 0.2 || p.precipProb >= 40) parts.push('возможен дождь')

  if (p.humidity >= 80 && p.feelsLike < 12) parts.push('сыро')
  else if (p.humidity >= 75) parts.push('влажно')

  if (p.windMs >= 8) parts.push('сильно ветрено')
  else if (p.windMs >= 4.5) parts.push('ветрено')

  if (p.cloudCover <= 25) parts.push('ясно')
  else if (p.cloudCover >= 80) parts.push('пасмурно')

  if (parts.length === 0) {
    if (p.feelsLike <= 0) parts.push('морозно')
    else if (p.feelsLike < 8) parts.push('прохладно')
    else if (p.feelsLike < 18) parts.push('мягко')
    else if (p.feelsLike < 26) parts.push('тепло')
    else parts.push('жарко')
  }

  const sign = p.feelsLike > 0 ? '+' : ''
  return `${parts.join(' · ')} ${sign}${Math.round(p.feelsLike)}°`
}

export function formatFeels(n: number): string {
  const sign = n > 0 ? '+' : ''
  return `${sign}${Math.round(n)}°`
}
