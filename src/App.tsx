import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  addLook,
  deleteLook,
  getSettings,
  listLooks,
  saveSettings,
  updateLook,
  updateLookFeedback,
} from './db'
import {
  importBackupFile,
  shareOrDownloadBackup,
  shouldRemindBackup,
  markBackupDone,
} from './looks/backup'
import {
  restoreBackupFromGithub,
  saveBackupToGithub,
} from './looks/githubBackup'
import {
  compressImage,
  blobToObjectUrl,
  extractPhotoMeta,
} from './looks/media'
import {
  looksNeedingFeedback,
  rainAdvice,
  rankLooks,
} from './looks/recommend'
import type {
  Feedback,
  LocationSource,
  Look,
  Place,
  Settings,
  Tab,
  WeatherProfile,
} from './types'
import {
  fetchWeatherForDate,
  formatFeels,
  reverseGeocode,
  searchPlaces,
  weatherLabel,
} from './weather/api'

function todayISO() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  const local = new Date(d.getTime() - off * 60_000)
  return local.toISOString().slice(0, 10)
}

function tomorrowISO() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const off = d.getTimezoneOffset()
  const local = new Date(d.getTime() - off * 60_000)
  return local.toISOString().slice(0, 10)
}

/** Next full hour, or 09:00 if still early. */
function defaultOutingTime(): string {
  const now = new Date()
  const next = new Date(now)
  next.setMinutes(0, 0, 0)
  next.setHours(next.getHours() + 1)
  const h = next.getHours()
  if (h < 7) return '09:00'
  return `${String(h).padStart(2, '0')}:00`
}

function formatDateRu(iso: string, time?: string) {
  const d = new Date(iso + 'T12:00:00')
  const day = d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
  })
  return time ? `${day}, ${time}` : day
}

function formatPickerDate(iso: string) {
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function sourceLabel(source?: LocationSource) {
  switch (source) {
    case 'photo':
      return 'место с фото'
    case 'geo':
      return 'геолокация'
    case 'search':
      return 'поиск'
    case 'settings':
      return 'из настроек'
    default:
      return 'место'
  }
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

function DatePicker({
  value,
  onChange,
  hint = 'дата',
}: {
  value: string
  onChange: (v: string) => void
  hint?: string
}) {
  const id = useId()
  return (
    <label className="picker" htmlFor={id}>
      <span className="picker-value">{formatPickerDate(value)}</span>
      <span className="picker-hint">{hint}</span>
      <input
        id={id}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function TimePicker({
  value,
  onChange,
  hint = 'время',
}: {
  value: string
  onChange: (v: string) => void
  hint?: string
}) {
  const id = useId()
  return (
    <label className="picker" htmlFor={id}>
      <span className="picker-value">{value || '—:—'}</span>
      <span className="picker-hint">{hint}</span>
      <input
        id={id}
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
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
    <div className="feedback-block">
      <p className="feedback-caption">в этой одежде было</p>
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
    </div>
  )
}

type PlaceState = Place & { source: LocationSource }

function LocationEditor({
  place,
  onChange,
  compact = false,
}: {
  place: PlaceState
  onChange: (next: PlaceState) => void
  compact?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<
    Array<{ name: string; latitude: number; longitude: number }>
  >([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runSearch() {
    setError(null)
    if (!query.trim()) {
      setError('Введи название города')
      return
    }
    setBusy(true)
    try {
      const found = await searchPlaces(query.trim())
      setResults(found)
      if (found.length === 0) setError('Ничего не найдено')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function requestGeo() {
    setError(null)
    if (!navigator.geolocation) {
      setError('Геолокация недоступна')
      return
    }
    setBusy(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const resolved = await reverseGeocode(
            pos.coords.latitude,
            pos.coords.longitude,
          )
          onChange({
            placeName: resolved.name,
            latitude: resolved.latitude,
            longitude: resolved.longitude,
            source: 'geo',
          })
          setEditing(true)
          setQuery(resolved.name.split(',')[0] ?? resolved.name)
          setResults([])
        } catch (e) {
          setError((e as Error).message)
        } finally {
          setBusy(false)
        }
      },
      () => {
        setBusy(false)
        setError('Не удалось получить геолокацию — лучше найди город')
        setEditing(true)
      },
      { enableHighAccuracy: false, timeout: 12000 },
    )
  }

  return (
    <div className="place-card corner">
      <p className="place-card-label">{sourceLabel(place.source)}</p>
      <p className="place-card-name">{place.placeName}</p>
      {!editing ? (
        <div className="place-card-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setEditing(true)
              setQuery(place.placeName.split(',')[0] ?? place.placeName)
              setResults([])
              setError(null)
            }}
          >
            это неверно
          </button>
          {!compact && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void requestGeo()}
              disabled={busy}
            >
              {busy ? '…' : 'гео'}
            </button>
          )}
        </div>
      ) : (
        <div className="place-search">
          <p className="status">Найди город вручную — так точнее, чем GPS.</p>
          <div className="field">
            <label htmlFor={`place-q-${place.latitude}`}>город</label>
            <input
              id={`place-q-${place.latitude}`}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch()
              }}
              placeholder="Москва, Стамбул…"
              autoComplete="address-level2"
            />
          </div>
          <div className="place-card-actions">
            <button
              type="button"
              className="olive-btn"
              onClick={() => void runSearch()}
              disabled={busy}
            >
              {busy ? 'ищу…' : 'найти'}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setEditing(false)
                setResults([])
                setError(null)
              }}
            >
              отмена
            </button>
          </div>
          <div className="search-list">
            {results.map((r) => (
              <button
                key={`${r.latitude}-${r.longitude}`}
                type="button"
                onClick={() => {
                  onChange({
                    placeName: r.name,
                    latitude: r.latitude,
                    longitude: r.longitude,
                    source: 'search',
                  })
                  setEditing(false)
                  setResults([])
                  setError(null)
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function CityOnboarding({
  settings,
  onDone,
}: {
  settings: Settings
  onDone: (s: Settings) => void
}) {
  const [place, setPlace] = useState<PlaceState>({
    ...settings,
    source: 'settings',
  })
  const [saving, setSaving] = useState(false)

  async function confirm() {
    setSaving(true)
    const next: Settings = {
      ...settings,
      placeName: place.placeName,
      latitude: place.latitude,
      longitude: place.longitude,
      cityConfirmed: true,
    }
    await saveSettings(next)
    onDone(next)
    setSaving(false)
  }

  return (
    <div className="onboard-overlay" role="dialog" aria-modal="true">
      <div className="onboard-sheet corner">
        <div className="section-kicker">старт</div>
        <h2 className="block-title">где ты сейчас?</h2>
        <p className="onboard-copy">
          Город нужен для погоды «сегодня». Можно взять гео или найти вручную.
        </p>
        <LocationEditor place={place} onChange={setPlace} />
        <button
          type="button"
          className="olive-btn"
          disabled={saving}
          onClick={() => void confirm()}
        >
          {saving ? 'сохраняю…' : 'это мой город'}
        </button>
      </div>
    </div>
  )
}

function TodayScreen({
  looks,
  settings,
  onFeedback,
  onAdd,
  onOpenSettings,
  onSettings,
}: {
  looks: Look[]
  settings: Settings
  onFeedback: (id: string, f: Feedback) => void
  onAdd: () => void
  onOpenSettings: () => void
  onSettings: (s: Settings) => void
}) {
  const [date, setDate] = useState(todayISO)
  const [outingTime, setOutingTime] = useState(defaultOutingTime)
  const [weather, setWeather] = useState<WeatherProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showBackupHint, setShowBackupHint] = useState(false)

  useEffect(() => {
    setShowBackupHint(shouldRemindBackup(settings, looks.length))
  }, [settings, looks.length])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchWeatherForDate(
      settings.latitude,
      settings.longitude,
      date,
      outingTime || undefined,
    )
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
  }, [date, outingTime, settings.latitude, settings.longitude])

  const ranked = useMemo(
    () => (weather ? rankLooks(looks, weather) : []),
    [looks, weather],
  )

  const rainTip = weather ? rainAdvice(weather) : null
  const needFeedback = useMemo(() => looksNeedingFeedback(looks, 2), [looks])

  async function dismissBackupHint() {
    const next: Settings = {
      ...settings,
      backupReminderDismissedAt: Date.now(),
    }
    await saveSettings(next)
    onSettings(next)
    setShowBackupHint(false)
  }

  return (
    <>
      <div className="section-kicker">атмосфера</div>
      <div className="control-row">
        <DatePicker value={date} onChange={setDate} />
        <button
          type="button"
          className="ghost-btn"
          data-active={date === todayISO()}
          onClick={() => setDate(todayISO())}
        >
          сегодня
        </button>
        <button
          type="button"
          className="ghost-btn"
          data-active={date === tomorrowISO()}
          onClick={() => setDate(tomorrowISO())}
        >
          завтра
        </button>
      </div>

      <div className="control-row outing-row">
        <TimePicker
          value={outingTime}
          onChange={setOutingTime}
          hint="сейчас выхожу"
        />
      </div>

      {showBackupHint && (
        <div className="soft-nudge corner">
          <p>Пора бэкапнуть луки — в приватный Gist на GitHub.</p>
          <div className="nudge-actions">
            <button
              type="button"
              className="olive-btn"
              onClick={onOpenSettings}
            >
              открыть бэкап
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void dismissBackupHint()}
            >
              позже
            </button>
          </div>
        </div>
      )}

      {needFeedback.length > 0 && (
        <div className="soft-nudge corner">
          <p>В этой одежде было? — за последние дни без отметки.</p>
          {needFeedback.slice(0, 2).map((look) => (
            <div key={look.id} className="nudge-look">
              <div className="nudge-look-thumb">
                <Photo blob={look.photoBlob} alt="" />
              </div>
              <div className="nudge-look-body">
                <p>{formatDateRu(look.date, look.time)}</p>
                <FeedbackBar
                  value={look.feedback}
                  onChange={(f) => onFeedback(look.id, f)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {loading && (
        <p className="status loading-pulse">собираю профиль погоды…</p>
      )}
      {error && <p className="error">{error}</p>}

      {weather && !loading && (
        <>
          <div className="hero-temp">
            <div className="deg">{formatFeels(weather.feelsLike)}</div>
            <div className="side">
              ощущается
              <br />
              {settings.placeName}
              <br />
              {formatDateRu(date)}
              {outingTime ? (
                <>
                  <br />в {outingTime}
                </>
              ) : null}
            </div>
          </div>
          <p className="weather-label">{weatherLabel(weather)}</p>
          {rainTip && <p className="rain-tip">{rainTip}</p>}
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
      {weather && !loading && looks.length > 0 && (
        <p className="rank-hint">
          по похожей погоде{outingTime ? ` около ${outingTime}` : ''}:
          ощущается, ветер, влажность, осадки
        </p>
      )}
      {looks.length === 0 && (
        <div className="empty-actions">
          <p className="empty">
            Пока нет луков. Добавь первый — и рекомендации появятся сами.
          </p>
          <button type="button" className="olive-btn" onClick={onAdd}>
            добавить лук
          </button>
        </div>
      )}
      {weather && !loading && looks.length > 0 && ranked.length === 0 && (
        <p className="empty">
          Нет луков за другие дни — добавь ещё образы, чтобы сравнить погоду.
        </p>
      )}
      <div className="look-grid">
        {ranked.map(({ look, reason, matchPercent: pct }, i) => (
          <article
            key={look.id}
            className="look-card"
            style={{ animationDelay: `${i * 50}ms` }}
          >
            <div className="look-thumb">
              <Photo blob={look.photoBlob} alt={`Лук ${look.date}`} />
              <span className="match-badge">{pct}%</span>
            </div>
            <div className="look-card-body">
              <h3>{formatDateRu(look.date, look.time)}</h3>
              <p className="look-reason">{reason}</p>
              <FeedbackBar
                value={look.feedback}
                onChange={(f) => onFeedback(look.id, f)}
              />
            </div>
          </article>
        ))}
      </div>
    </>
  )
}

function AddLookScreen({
  settings,
  onSaved,
  onFeedback,
}: {
  settings: Settings
  onSaved: () => void
  onFeedback: (id: string, f: Feedback) => Promise<void>
}) {
  const galleryRef = useRef<HTMLInputElement>(null)
  const [date, setDate] = useState(todayISO)
  const [time, setTime] = useState('')
  const [takenAt, setTakenAt] = useState<string | undefined>()
  const [metaSource, setMetaSource] = useState<
    'exif' | 'file' | 'now' | null
  >(null)
  const [place, setPlace] = useState<PlaceState>({
    ...settings,
    source: 'settings',
  })
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [weather, setWeather] = useState<WeatherProfile | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingFeedback, setPendingFeedback] = useState<Look | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchWeatherForDate(
      place.latitude,
      place.longitude,
      date,
      time || undefined,
    )
      .then((w) => {
        if (!cancelled) {
          setWeather(w)
          setError(null)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [date, time, place.latitude, place.longitude])

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
      const meta = await extractPhotoMeta(file)
      setDate(meta.date)
      setTime(meta.time)
      setTakenAt(meta.takenAt)
      setMetaSource(meta.source)

      if (meta.gps) {
        setStatus('определяю место по фото…')
        try {
          const resolved = await reverseGeocode(
            meta.gps.latitude,
            meta.gps.longitude,
          )
          setPlace({
            placeName: resolved.name,
            latitude: resolved.latitude,
            longitude: resolved.longitude,
            source: 'photo',
          })
        } catch {
          setPlace({
            placeName: `${meta.gps.latitude.toFixed(2)}, ${meta.gps.longitude.toFixed(2)}`,
            latitude: meta.gps.latitude,
            longitude: meta.gps.longitude,
            source: 'photo',
          })
        }
      } else {
        setPlace({ ...settings, source: 'settings' })
      }

      setStatus('сжимаю фото…')
      const compressed = await compressImage(file)
      if (preview) URL.revokeObjectURL(preview)
      setBlob(compressed)
      setPreview(URL.createObjectURL(compressed))
      setStatus(
        meta.source === 'exif'
          ? `снято ${formatDateRu(meta.date, meta.time)}`
          : meta.source === 'file'
            ? `дата файла ${formatDateRu(meta.date, meta.time)}`
            : null,
      )
    } catch {
      setError('Не удалось обработать фото')
      setStatus(null)
    }
  }

  async function save() {
    if (!blob || !weather) {
      setError('Сначала добавь фото')
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
        placeName: place.placeName,
        latitude: place.latitude,
        longitude: place.longitude,
        locationSource: place.source,
      }
      await addLook(look)
      setNote('')
      setBlob(null)
      setTime('')
      setTakenAt(undefined)
      setMetaSource(null)
      setPlace({ ...settings, source: 'settings' })
      if (preview) URL.revokeObjectURL(preview)
      setPreview(null)
      setStatus(null)
      setPendingFeedback(look)
    } catch {
      setError('Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function finishFeedback(f?: Feedback) {
    if (pendingFeedback && f) {
      await onFeedback(pendingFeedback.id, f)
    }
    setPendingFeedback(null)
    onSaved()
  }

  if (pendingFeedback) {
    return (
      <>
        <div className="section-kicker">сохранено</div>
        <h2 className="block-title">в этой одежде было?</h2>
        <div className="form-stack">
          <div className="photo-drop corner has-photo">
            <Photo blob={pendingFeedback.photoBlob} alt="Сохранённый лук" />
          </div>
          <p className="status">
            {formatDateRu(pendingFeedback.date, pendingFeedback.time)} ·{' '}
            {weatherLabel(pendingFeedback.weather)}
          </p>
          <FeedbackBar
            value={pendingFeedback.feedback}
            onChange={(f) => void finishFeedback(f)}
          />
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void finishFeedback()}
          >
            пропустить
          </button>
        </div>
      </>
    )
  }

  const metaLabel =
    metaSource === 'exif'
      ? 'из фото'
      : metaSource === 'file'
        ? 'из файла'
        : null

  return (
    <>
      <div className="section-kicker">новый лук</div>
      <h2 className="block-title">записать образ</h2>
      <div className="form-stack">
        <button
          type="button"
          className={`photo-drop corner ${preview ? 'has-photo' : ''}`}
          onClick={() => galleryRef.current?.click()}
        >
          {preview && <img src={preview} alt="Превью лука" />}
          <div className="hint">
            фото образа
            <small>дата и место — из снимка, если есть</small>
          </div>
        </button>
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
              ref={galleryRef}
              type="file"
              accept="image/*"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </label>
        </div>
        <div className="field-row">
          <div className="field">
            <label>
              дата
              {metaLabel ? <span className="field-tag">{metaLabel}</span> : null}
            </label>
            <DatePicker
              value={date}
              hint="выбрать"
              onChange={(v) => {
                setDate(v)
                setMetaSource(null)
              }}
            />
          </div>
          <div className="field">
            <label>
              время
              {metaLabel ? <span className="field-tag">{metaLabel}</span> : null}
            </label>
            <TimePicker
              value={time}
              hint="выбрать"
              onChange={(v) => {
                setTime(v)
                setMetaSource(null)
              }}
            />
          </div>
        </div>
        <LocationEditor place={place} onChange={setPlace} />
        {weather && (
          <p className="weather-line">
            погода{time ? ` в ${time}` : ''} · {weatherLabel(weather)}
            <span>
              ветер {weather.windMs} м/с · влажн. {weather.humidity}%
            </span>
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
          disabled={saving || !blob}
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
  settings,
  onFeedback,
  onDelete,
  onUpdated,
  onAdd,
}: {
  looks: Look[]
  settings: Settings
  onFeedback: (id: string, f: Feedback) => void
  onDelete: (id: string) => void
  onUpdated: () => void
  onAdd: () => void
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [locBusy, setLocBusy] = useState(false)
  const [locError, setLocError] = useState<string | null>(null)

  async function applyPlace(look: Look, next: PlaceState) {
    setLocBusy(true)
    setLocError(null)
    try {
      const weather = await fetchWeatherForDate(
        next.latitude,
        next.longitude,
        look.date,
        look.time,
      )
      await updateLook(look.id, {
        placeName: next.placeName,
        latitude: next.latitude,
        longitude: next.longitude,
        locationSource: next.source,
        weather,
      })
      setEditingId(null)
      onUpdated()
    } catch (e) {
      setLocError((e as Error).message)
    } finally {
      setLocBusy(false)
    }
  }

  return (
    <>
      <div className="section-kicker">архив</div>
      <h2 className="block-title">все луки</h2>
      {looks.length === 0 && (
        <div className="empty-actions">
          <p className="empty">Архив пуст — начни с сегодняшнего образа.</p>
          <button type="button" className="olive-btn" onClick={onAdd}>
            добавить лук
          </button>
        </div>
      )}
      <div className="look-grid archive-grid">
        {looks.map((look) => {
          const place: PlaceState = {
            placeName: look.placeName || settings.placeName,
            latitude: look.latitude ?? settings.latitude,
            longitude: look.longitude ?? settings.longitude,
            source: look.locationSource ?? 'settings',
          }
          return (
            <article key={look.id} className="look-card">
              <div className="look-thumb">
                <Photo blob={look.photoBlob} alt={`Лук ${look.date}`} />
                <span className="match-badge">
                  {formatFeels(look.weather.feelsLike)}
                </span>
              </div>
              <div className="look-card-body">
                <h3>{formatDateRu(look.date, look.time)}</h3>
                <p className="look-reason">
                  {place.placeName} · {weatherLabel(look.weather)}
                  {look.note ? ` · ${look.note}` : ''}
                </p>
                <FeedbackBar
                  value={look.feedback}
                  onChange={(f) => onFeedback(look.id, f)}
                />
                {editingId === look.id ? (
                  <>
                    <LocationEditor
                      place={place}
                      compact
                      onChange={(next) => void applyPlace(look, next)}
                    />
                    {locBusy && (
                      <p className="status loading-pulse">обновляю погоду…</p>
                    )}
                    {locError && <p className="error">{locError}</p>}
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => setEditingId(null)}
                    >
                      закрыть место
                    </button>
                  </>
                ) : (
                  <div className="card-actions">
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        setEditingId(look.id)
                        setLocError(null)
                      }}
                    >
                      место
                    </button>
                    {pendingDelete === look.id ? null : (
                      <button
                        type="button"
                        className="text-btn"
                        onClick={() => setPendingDelete(look.id)}
                      >
                        удалить
                      </button>
                    )}
                  </div>
                )}
                {pendingDelete === look.id && (
                  <div className="confirm-bar">
                    <p>удалить этот лук?</p>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => setPendingDelete(null)}
                    >
                      отмена
                    </button>
                    <button
                      type="button"
                      className="solid-btn"
                      onClick={() => {
                        onDelete(look.id)
                        setPendingDelete(null)
                      }}
                    >
                      удалить
                    </button>
                  </div>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </>
  )
}

function SettingsScreen({
  settings,
  looksCount,
  onSettings,
}: {
  settings: Settings
  looksCount: number
  onSettings: (s: Settings) => void
}) {
  const [place, setPlace] = useState<PlaceState>({
    ...settings,
    source: 'settings',
  })
  const [token, setToken] = useState(settings.githubToken ?? '')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPlace({ ...settings, source: 'settings' })
    setToken(settings.githubToken ?? '')
  }, [settings])

  async function persist(next: PlaceState) {
    setPlace(next)
    const saved: Settings = {
      ...settings,
      placeName: next.placeName,
      latitude: next.latitude,
      longitude: next.longitude,
      cityConfirmed: true,
    }
    await saveSettings(saved)
    onSettings(saved)
    setStatus(`город: ${next.placeName}`)
    setError(null)
  }

  async function saveToken() {
    const next: Settings = {
      ...settings,
      githubToken: token.trim() || undefined,
    }
    await saveSettings(next)
    onSettings(next)
    setStatus(
      token.trim()
        ? 'токен сохранён на этом телефоне'
        : 'токен удалён с телефона',
    )
    setError(null)
  }

  async function exportBackup() {
    setError(null)
    try {
      await shareOrDownloadBackup()
      const next = await markBackupDone(looksCount)
      onSettings(next)
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

  async function githubSave() {
    setBusy(true)
    setError(null)
    try {
      if (token.trim() !== (settings.githubToken ?? '')) {
        await saveSettings({ ...settings, githubToken: token.trim() })
      }
      const result = await saveBackupToGithub()
      const refreshed = await getSettings()
      onSettings(refreshed)
      setStatus(
        result.recompressed
          ? `сохранено в GitHub (gist ${result.gistId.slice(0, 8)}…) — фото сжаты сильнее`
          : `сохранено в GitHub (gist ${result.gistId.slice(0, 8)}…)`,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function githubRestore() {
    setBusy(true)
    setError(null)
    try {
      if (token.trim() !== (settings.githubToken ?? '')) {
        await saveSettings({ ...settings, githubToken: token.trim() })
      }
      const n = await restoreBackupFromGithub()
      setStatus(`восстановлено луков: ${n}`)
      window.location.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="section-kicker">настройки</div>
      <h2 className="block-title">город и бэкап</h2>
      <div className="settings-stack">
        <p>
          Город по умолчанию — для «сегодня» и луков без GPS. Если геолокация
          ошиблась — нажми «это неверно» и найди город вручную.
        </p>
        <LocationEditor
          place={place}
          onChange={(next) => void persist(next)}
        />
        <p className="meta-chip">
          сейчас · {settings.placeName} · {settings.latitude.toFixed(2)},{' '}
          {settings.longitude.toFixed(2)}
        </p>

        <h3 className="settings-sub">бэкап в GitHub</h3>
        <p>
          Публичный репозиторий — только код. Личные фото — в приватный Gist.
          Токен остаётся на телефоне, в репозиторий не попадает.
        </p>
        <div className="field">
          <label htmlFor="gh-token">GitHub PAT</label>
          <input
            id="gh-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_… или github_pat_…"
          />
        </div>
        <p className="field-hint">
          Classic: право <code>gist</code>. Fine-grained: доступ к Gists.
          {settings.githubGistId
            ? ` Gist: ${settings.githubGistId.slice(0, 10)}…`
            : ''}
        </p>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void saveToken()}
        >
          сохранить токен
        </button>
        <div className="settings-actions">
          <button
            type="button"
            className="olive-btn"
            disabled={busy}
            onClick={() => void githubSave()}
          >
            {busy ? '…' : 'сохранить в GitHub'}
          </button>
          <button
            type="button"
            className="solid-btn"
            disabled={busy}
            onClick={() => void githubRestore()}
          >
            восстановить из GitHub
          </button>
        </div>

        <h3 className="settings-sub">файлы</h3>
        <button
          type="button"
          className="solid-btn"
          onClick={() => void exportBackup()}
        >
          экспорт в файлы
        </button>
        <label className="file-btn">
          импорт бэкапа
          <input
            type="file"
            accept="application/json,.json"
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
    await deleteLook(id)
    await refresh()
  }

  if (!settings) {
    return (
      <div className="app">
        <div className="dot-grid" />
        <div className="shell">
          <div className="brand">
            look<span>.</span>
          </div>
          <p className="status loading-pulse">загрузка…</p>
        </div>
      </div>
    )
  }

  const needsCity = !settings.cityConfirmed

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
            onAdd={() => setTab('add')}
            onOpenSettings={() => setTab('settings')}
            onSettings={setSettings}
          />
        )}
        {tab === 'add' && (
          <AddLookScreen
            settings={settings}
            onFeedback={onFeedback}
            onSaved={() => {
              void refresh()
              setTab('today')
            }}
          />
        )}
        {tab === 'archive' && (
          <ArchiveScreen
            looks={looks}
            settings={settings}
            onFeedback={onFeedback}
            onDelete={onDelete}
            onUpdated={() => void refresh()}
            onAdd={() => setTab('add')}
          />
        )}
        {tab === 'settings' && (
          <SettingsScreen
            settings={settings}
            looksCount={looks.length}
            onSettings={setSettings}
          />
        )}
      </div>

      <nav className="nav" aria-label="Навигация">
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

      {needsCity && (
        <CityOnboarding settings={settings} onDone={setSettings} />
      )}
    </div>
  )
}
