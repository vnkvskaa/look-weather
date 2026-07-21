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
  hourly?: HourlyBlock
}

type ArchiveResponse = {
  daily: DailyBlock
  hourly?: HourlyBlock
}

type HourlyBlock = {
  time: string[]
  temperature_2m?: number[]
  apparent_temperature?: number[]
  relative_humidity_2m?: number[]
  precipitation?: number[]
  precipitation_probability?: number[]
  cloud_cover?: number[]
  wind_speed_10m?: number[]
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

function closestHourIndex(times: string[], date: string, time: string): number {
  const target = `${date}T${time}`
  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < times.length; i++) {
    const t = times[i]
    if (!t.startsWith(date)) continue
    const diff = Math.abs(
      new Date(t).getTime() - new Date(target.length === 16 ? `${target}:00` : target).getTime(),
    )
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  }
  return best
}

function applyHourly(
  base: WeatherProfile,
  hourly: HourlyBlock | undefined,
  date: string,
  time?: string,
): WeatherProfile {
  if (!hourly?.time?.length || !time) return base
  const i = closestHourIndex(hourly.time, date, time)
  const feels = hourly.apparent_temperature?.[i]
  const temp = hourly.temperature_2m?.[i]
  const wind = hourly.wind_speed_10m?.[i]
  const humidity = hourly.relative_humidity_2m?.[i]
  const cloud = hourly.cloud_cover?.[i]
  const precipHour = hourly.precipitation?.[i]
  const precipProb = hourly.precipitation_probability?.[i]

  return {
    ...base,
    feelsLike:
      feels != null ? Math.round(feels * 10) / 10 : base.feelsLike,
    tempMean: temp != null ? Math.round(temp * 10) / 10 : base.tempMean,
    windMs: wind != null ? Math.round(wind * 10) / 10 : base.windMs,
    humidity: humidity != null ? Math.round(humidity) : base.humidity,
    cloudCover: cloud != null ? Math.round(cloud) : base.cloudCover,
    precipProb:
      precipProb != null ? Math.round(precipProb) : base.precipProb,
    // keep daily precipMm as day total; bump label signal if hour is wet
    precipMm:
      precipHour != null && precipHour > base.precipMm
        ? Math.round(precipHour * 10) / 10
        : base.precipMm,
  }
}

const DAILY =
  'temperature_2m_mean,apparent_temperature_mean,apparent_temperature_max,wind_speed_10m_max,precipitation_sum,precipitation_probability_max,cloud_cover_mean,relative_humidity_2m_mean'

const HOURLY =
  'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,precipitation_probability,cloud_cover,wind_speed_10m'

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
    name: formatPlaceShort([r.name, r.country].filter(Boolean).join(', ')),
    latitude: r.latitude,
    longitude: r.longitude,
  }))
}

/**
 * Display place as «город, страна» — drop region/admin middle parts.
 * Works for fresh geocode and older longer strings already stored.
 */
export function formatPlaceShort(name?: string | null): string {
  if (!name?.trim()) return '—'
  const parts = name
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return '—'
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return `${parts[0]}, ${parts[1]}`
  return `${parts[0]}, ${parts[parts.length - 1]}`
}

/** Resolve a human place name for coordinates (photo GPS / device geo). */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<{ name: string; latitude: number; longitude: number }> {
  const url = new URL(
    'https://api.bigdatacloud.net/data/reverse-geocode-client',
  )
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('localityLanguage', 'ru')
  const res = await fetch(url)
  if (!res.ok) throw new Error('Не удалось определить место')
  const data = (await res.json()) as {
    city?: string
    locality?: string
    principalSubdivision?: string
    countryName?: string
  }
  const city = data.city || data.locality || data.principalSubdivision
  const country = data.countryName
  const raw = [city, country].filter(Boolean).join(', ')
  return {
    name: formatPlaceShort(raw) || `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
    latitude,
    longitude,
  }
}

/** Local calendar YYYY-MM-DD — not UTC (toISOString shifts the day near midnight). */
function localISODate(d: Date): string {
  const off = d.getTimezoneOffset()
  const local = new Date(d.getTime() - off * 60_000)
  return local.toISOString().slice(0, 10)
}

export async function fetchWeatherForDate(
  latitude: number,
  longitude: number,
  date: string,
  time?: string,
): Promise<WeatherProfile> {
  const todayStr = localISODate(new Date())
  const target = new Date(date + 'T12:00:00')
  const diffDays = Math.floor(
    (target.getTime() - new Date(todayStr + 'T12:00:00').getTime()) /
      (1000 * 60 * 60 * 24),
  )

  if (diffDays >= -5 && diffDays <= 14) {
    return fetchForecastDay(latitude, longitude, date, time)
  }
  return fetchArchiveDay(latitude, longitude, date, time)
}

async function fetchForecastDay(
  latitude: number,
  longitude: number,
  date: string,
  time?: string,
): Promise<WeatherProfile> {
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('daily', DAILY)
  url.searchParams.set('hourly', HOURLY)
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('forecast_days', '16')
  url.searchParams.set('past_days', '5')
  url.searchParams.set('wind_speed_unit', 'ms')

  const res = await fetch(url)
  if (!res.ok) throw new Error('Не удалось загрузить прогноз')
  const data = (await res.json()) as ForecastResponse
  const idx = data.daily.time.indexOf(date)
  if (idx < 0) {
    return fetchArchiveDay(latitude, longitude, date, time)
  }
  return applyHourly(toProfile(data.daily, idx), data.hourly, date, time)
}

async function fetchArchiveDay(
  latitude: number,
  longitude: number,
  date: string,
  time?: string,
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
  url.searchParams.set(
    'hourly',
    'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,cloud_cover,wind_speed_10m',
  )
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('wind_speed_unit', 'ms')

  const res = await fetch(url)
  if (!res.ok) throw new Error('Не удалось загрузить архив погоды')
  const data = (await res.json()) as ArchiveResponse
  if (!data.daily?.time?.length) throw new Error('Нет данных за этот день')
  const profile = applyHourly(toProfile(data.daily, 0), data.hourly, date, time)
  if (profile.precipProb === 0) {
    profile.precipProb = profile.precipMm > 0.2 ? 80 : 10
  }
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
