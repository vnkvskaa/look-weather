import { useEffect, useMemo, useState } from 'react'
import {
  addLook,
  deleteLook,
  getSettings,
  listLooks,
  saveSettings,
  updateLookFeedback,
} from './db'
import { importBackupFile, shareOrDownloadBackup } from './looks/backup'
import { compressImage, blobToObjectUrl, extractPhotoTakenAt } from './looks/media'
import { rankLooks } from './looks/recommend'
import type { Feedback, Look, Settings, Tab, WeatherProfile } from './types'
import {
  fetchWeatherForDate,
  formatFeels,
  searchPlaces,
  weatherLabel,
} from './weather/api'

function todayISO() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  const local = new Date(d.getTime() - off * 60_000)
  return local.toISOString().slice(0, 10)
}

function formatDateRu(iso: string, time?: string) {
  const d = new Date(iso + 'T12:00:00')
  const day = d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
  })
  return time ? `${day}, ${time}` : day
}

function useLooks() {
  const [looks, setLooks] = useState<Look[]>([])
  const refresh = async () => setLooks(await listLooks())
  useEffect(() => {
    void refresh()
  }, [])
  return { looks, refresh }
}

function Photo({ blob, alt }: { blob: Blob; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = blobToObjectUrl(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  if (!url) return null
  return <img src={url} alt={alt} />
}

function FeedbackBar({
  value,
  onChange,
}: {
  value?: Feedback
  onChange: (f: Feedback) => void
}) {
  const items: Array<{ id: Feedback; label: string }> = [
    { id: 'too_cold', label: 'холодно' },
    { id: 'ok', label: 'норм' },
    { id: 'too_hot', label: 'жарко' },
  ]
  return (
    <div className="feedback-row">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-active={value === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function TodayScreen({
  looks,
  settings,
  onFeedback,
}: {
  looks: Look[]
  settings: Settings
  onFeedback: (id: string, f: Feedback) => void
}) {
  const [date, setDate] = useState(todayISO)
  const [weather, setWeather] = useState<WeatherProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchWeatherForDate(settings.latitude, settings.longitude, date)
      .then((w) => {
        if (!cancelled) setWeather(w)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [date, settings.latitude, settings.longitude])

  const ranked = useMemo(
    () => (weather ? rankLooks(looks, weather) : []),
    [looks, weather],
  )

  return (
    <>
      <div className="section-kicker">atmosphere</div>
      <div className="date-row">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setDate(todayISO())}
        >
          сегодня
        </button>
      </div>

      {loading && (
        <p className="status loading-pulse">собираю профиль погоды…</p>
      )}
      {error && <p className="error">{error}</p>}

      {weather && !loading && (
        <>
          <div className="hero-temp">
            <div className="deg">{formatFeels(weather.feelsLike)}</div>
            <div className="side">
              feels like
              <br />
              {settings.placeName}
              <br />
              {formatDateRu(date)}
            </div>
          </div>
          <p className="weather-label">{weatherLabel(weather)}</p>
          <div className="stats corner">
            <div className="stat">
              <b>{Math.round(weather.tempMean)}°</b>
              <span>воздух</span>
            </div>
            <div className="stat">
              <b>{weather.windMs}</b>
              <span>ветер м/с</span>
            </div>
            <div className="stat">
              <b>{weather.humidity}%</b>
              <span>влажн.</span>
            </div>
            <div className="stat">
              <b>{weather.precipProb}%</b>
              <span>осадки</span>
            </div>
          </div>
        </>
      )}

      <h2 className="block-title">что надеть</h2>
      {looks.length === 0 && (
        <p className="empty">
          Пока нет луков. Добавь первый — и рекомендации появятся сами.
        </p>
      )}
      {looks.length > 0 && ranked.length === 0 && weather && (
        <p className="empty">Недостаточно данных для ранжирования.</p>
      )}
      <div className="look-list">
        {ranked.map(({ look, reason, effectiveWarmth }, i) => (
          <article
            key={look.id}
            className="look-item"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="look-frame">
              <Photo blob={look.photoBlob} alt={`Лук ${look.date}`} />
            </div>
            <div className="look-meta">
              <div>
                <h3>{formatDateRu(look.date, look.time)}</h3>
                <p>{reason}</p>
              </div>
              <span className="badge">~{Math.round(effectiveWarmth)}°</span>
            </div>
            <FeedbackBar
              value={look.feedback}
              onChange={(f) => onFeedback(look.id, f)}
            />
          </article>
        ))}
      </div>
    </>
  )
}

function AddLookScreen({
  settings,
  onSaved,
}: {
  settings: Settings
  onSaved: () => void
}) {
  const [date, setDate] = useState(todayISO)
  const [time, setTime] = useState('')
  const [takenAt, setTakenAt] = useState<string | undefined>()
  const [metaSource, setMetaSource] = useState<
    'exif' | 'file' | 'now' | null
  >(null)
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [weather, setWeather] = useState<WeatherProfile | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchWeatherForDate(
      settings.latitude,
      settings.longitude,
      date,
      time || undefined,
    )
      .then((w) => {
        if (!cancelled) setWeather(w)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [date, time, settings.latitude, settings.longitude])

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  async function onFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setStatus('читаю метаданные…')
    try {
      const meta = await extractPhotoTakenAt(file)
      setDate(meta.date)
      setTime(meta.time)
      setTakenAt(meta.takenAt)
      setMetaSource(meta.source)

      setStatus('сжимаю фото…')
      const compressed = await compressImage(file)
      if (preview) URL.revokeObjectURL(preview)
      setBlob(compressed)
      setPreview(URL.createObjectURL(compressed))
      setStatus(
        meta.source === 'exif'
          ? `дата с фото: ${meta.date} ${meta.time}`
          : meta.source === 'file'
            ? `дата файла: ${meta.date} ${meta.time} (EXIF не найден)`
            : null,
      )
    } catch {
      setError('Не удалось обработать фото')
      setStatus(null)
    }
  }

  async function save() {
    if (!blob || !weather) {
      setError('Нужны фото и погода')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const look: Look = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        date,
        time: time || undefined,
        takenAt,
        note: note.trim() || undefined,
        photoBlob: blob,
        weather,
      }
      await addLook(look)
      setNote('')
      setBlob(null)
      setTime('')
      setTakenAt(undefined)
      setMetaSource(null)
      if (preview) URL.revokeObjectURL(preview)
      setPreview(null)
      setStatus('сохранено')
      onSaved()
    } catch {
      setError('Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="section-kicker">log look</div>
      <h2 className="block-title">лук дня</h2>
      <div className="form-stack">
        <div
          className={`photo-drop corner ${preview ? 'has-photo' : ''}`}
        >
          {preview && <img src={preview} alt="Превью лука" />}
          <div className="hint">фото образа</div>
        </div>
        <div className="photo-actions">
          <label>
            камера
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </label>
          <label>
            галерея
            <input
              type="file"
              accept="image/*"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </label>
        </div>
        <div className="field">
          <label htmlFor="look-date">
            дата
            {metaSource === 'exif'
              ? ' · из фото'
              : metaSource === 'file'
                ? ' · из файла'
                : ''}
          </label>
          <input
            id="look-date"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              setMetaSource(null)
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="look-time">
            время
            {metaSource === 'exif'
              ? ' · из фото'
              : metaSource === 'file'
                ? ' · из файла'
                : ''}
          </label>
          <input
            id="look-time"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value)
              setMetaSource(null)
            }}
          />
        </div>
        {weather && (
          <p className="status">
            погода{time ? ` в ${time}` : ' дня'}: {weatherLabel(weather)} ·
            ветер {weather.windMs} м/с · влажн. {weather.humidity}%
          </p>
        )}
        <div className="field">
          <label htmlFor="look-note">заметка</label>
          <textarea
            id="look-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="пальто / кроссовки / слой…"
          />
        </div>
        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}
        <button
          type="button"
          className="olive-btn"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'сохраняю…' : 'сохранить лук'}
        </button>
      </div>
    </>
  )
}

function ArchiveScreen({
  looks,
  onFeedback,
  onDelete,
}: {
  looks: Look[]
  onFeedback: (id: string, f: Feedback) => void
  onDelete: (id: string) => void
}) {
  return (
    <>
      <div className="section-kicker">archive</div>
      <h2 className="block-title">все луки</h2>
      {looks.length === 0 && (
        <p className="empty">Архив пуст — начни с сегодняшнего образа.</p>
      )}
      <div className="look-list">
        {looks.map((look) => (
          <article key={look.id} className="look-item">
            <div className="look-frame">
              <Photo blob={look.photoBlob} alt={`Лук ${look.date}`} />
            </div>
            <div className="look-meta">
              <div>
                <h3>{formatDateRu(look.date, look.time)}</h3>
                <p>
                  {weatherLabel(look.weather)}
                  {look.note ? ` · ${look.note}` : ''}
                </p>
              </div>
              <span className="badge">
                {formatFeels(look.weather.feelsLike)}
              </span>
            </div>
            <FeedbackBar
              value={look.feedback}
              onChange={(f) => onFeedback(look.id, f)}
            />
            <button
              type="button"
              className="ghost-btn"
              onClick={() => onDelete(look.id)}
            >
              удалить
            </button>
          </article>
        ))}
      </div>
    </>
  )
}

function SettingsScreen({
  settings,
  onSettings,
}: {
  settings: Settings
  onSettings: (s: Settings) => void
}) {
  const [query, setQuery] = useState(settings.placeName)
  const [results, setResults] = useState<
    Array<{ name: string; latitude: number; longitude: number }>
  >([])
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runSearch() {
    setError(null)
    try {
      const found = await searchPlaces(query.trim())
      setResults(found)
      if (found.length === 0) setStatus('ничего не найдено')
      else setStatus(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function useGeo() {
    setError(null)
    if (!navigator.geolocation) {
      setError('Геолокация недоступна')
      return
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const next: Settings = {
          placeName: 'здесь',
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }
        await saveSettings(next)
        onSettings(next)
        setStatus('локация обновлена')
      },
      () => setError('Не удалось получить геолокацию'),
    )
  }

  async function exportBackup() {
    setError(null)
    try {
      await shareOrDownloadBackup()
      setStatus('бэкап готов — сохрани в Файлы / iCloud')
    } catch {
      setError('Не удалось экспортировать')
    }
  }

  async function onImport(file: File | undefined) {
    if (!file) return
    setError(null)
    try {
      const n = await importBackupFile(file)
      setStatus(`импортировано луков: ${n}`)
      window.location.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <div className="section-kicker">settings</div>
      <h2 className="block-title">город и бэкап</h2>
      <div className="settings-stack">
        <p>
          Данные живут на этом телефоне. Для переноса — экспорт в Файлы → iCloud
          Drive, потом импорт.
        </p>
        <div className="field">
          <label htmlFor="city">город</label>
          <input
            id="city"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Москва"
          />
        </div>
        <div className="photo-actions">
          <button type="button" onClick={() => void runSearch()}>
            найти
          </button>
          <button type="button" onClick={() => void useGeo()}>
            геолокация
          </button>
        </div>
        <div className="search-list">
          {results.map((r) => (
            <button
              key={`${r.latitude}-${r.longitude}`}
              type="button"
              onClick={() => {
                const next = {
                  placeName: r.name,
                  latitude: r.latitude,
                  longitude: r.longitude,
                }
                void saveSettings(next).then(() => {
                  onSettings(next)
                  setStatus(`город: ${r.name}`)
                  setResults([])
                })
              }}
            >
              {r.name}
            </button>
          ))}
        </div>
        <p className="meta-chip">
          now · {settings.placeName} · {settings.latitude.toFixed(2)},{' '}
          {settings.longitude.toFixed(2)}
        </p>
        <button type="button" className="solid-btn" onClick={() => void exportBackup()}>
          экспорт в файлы / share
        </button>
        <label className="ghost-btn" style={{ display: 'grid' }}>
          импорт бэкапа
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void onImport(e.target.files?.[0])}
          />
        </label>
        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('today')
  const [settings, setSettings] = useState<Settings | null>(null)
  const { looks, refresh } = useLooks()

  useEffect(() => {
    void getSettings().then(setSettings)
  }, [])

  async function onFeedback(id: string, feedback: Feedback) {
    await updateLookFeedback(id, feedback)
    await refresh()
  }

  async function onDelete(id: string) {
    if (!confirm('Удалить этот лук?')) return
    await deleteLook(id)
    await refresh()
  }

  if (!settings) {
    return (
      <div className="app">
        <div className="dot-grid" />
        <div className="shell">
          <p className="status loading-pulse">look.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="dot-grid" aria-hidden />
      <div className="shell">
        <header className="brand-row">
          <div className="brand">
            look<span>.</span>
          </div>
          <div className="meta-chip">{looks.length} looks</div>
        </header>

        {tab === 'today' && (
          <TodayScreen
            looks={looks}
            settings={settings}
            onFeedback={onFeedback}
          />
        )}
        {tab === 'add' && (
          <AddLookScreen
            settings={settings}
            onSaved={() => {
              void refresh()
              setTab('archive')
            }}
          />
        )}
        {tab === 'archive' && (
          <ArchiveScreen
            looks={looks}
            onFeedback={onFeedback}
            onDelete={onDelete}
          />
        )}
        {tab === 'settings' && (
          <SettingsScreen settings={settings} onSettings={setSettings} />
        )}
      </div>

      <nav className="nav">
        {(
          [
            ['today', 'сегодня'],
            ['add', 'добавить'],
            ['archive', 'архив'],
            ['settings', 'ещё'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-active={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}
