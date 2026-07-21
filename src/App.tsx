import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
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
  getAutoBackupStatus,
  isAutoBackupEnabled,
  scheduleAutoBackup,
  subscribeAutoBackup,
  suppressAutoBackup,
  type AutoBackupStatus,
} from './looks/autoBackup'
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
  groupLooksByDate,
  placeSummary,
} from './looks/dayGroups'
import {
  looksNeedingFeedback,
  rankDayGroups,
  weatherTips,
} from './looks/recommend'
import type {
  DayGroup,
  Feedback,
  ItemTag,
  LocationSource,
  Look,
  Place,
  Settings,
  Tab,
  WeatherProfile,
} from './types'
import { ITEM_TAGS } from './types'
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
  note,
  onChange,
  onNoteChange,
  showNote = false,
}: {
  value?: Feedback
  note?: string
  onChange: (f: Feedback) => void
  onNoteChange?: (note: string) => void
  showNote?: boolean
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
      {showNote && onNoteChange && (
        <input
          className="feedback-note"
          type="text"
          value={note ?? ''}
          onChange={(e) => onNoteChange(e.target.value.slice(0, 80))}
          placeholder="короткая заметка…"
          maxLength={80}
          aria-label="заметка к ощущению"
        />
      )}
      {!showNote && note ? (
        <p className="feedback-note-text">{note}</p>
      ) : null}
    </div>
  )
}

function ItemTagsPicker({
  value,
  onChange,
}: {
  value: ItemTag[]
  onChange: (next: ItemTag[]) => void
}) {
  function toggle(tag: ItemTag) {
    if (value.includes(tag)) {
      onChange(value.filter((t) => t !== tag))
    } else {
      onChange([...value, tag])
    }
  }
  return (
    <div className="item-tags">
      <p className="item-tags-label">что на тебе</p>
      <div className="item-tags-row">
        {ITEM_TAGS.map((tag) => (
          <button
            key={tag}
            type="button"
            className="tag-chip"
            data-active={value.includes(tag)}
            onClick={() => toggle(tag)}
          >
            {tag}
          </button>
        ))}
      </div>
    </div>
  )
}

function ItemTagsDisplay({ items }: { items?: ItemTag[] }) {
  if (!items?.length) return null
  return (
    <div className="item-tags-display">
      {items.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
  )
}

const PWA_HINT_KEY = 'look-weather-pwa-hint-dismissed'

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone =
    ('standalone' in navigator &&
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone)) ||
    window.matchMedia('(display-mode: standalone)').matches
  return iOS && !standalone
}

function PwaInstallHint() {
  const [visible, setVisible] = useState(() => {
    try {
      return isIosSafari() && localStorage.getItem(PWA_HINT_KEY) !== '1'
    } catch {
      return false
    }
  })

  if (!visible) return null

  function dismiss() {
    try {
      localStorage.setItem(PWA_HINT_KEY, '1')
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  return (
    <div className="pwa-hint corner">
      <p>
        Добавить на экран «Домой»: Поделиться → На экран «Домой».
      </p>
      <button type="button" className="ghost-btn" onClick={dismiss}>
        ясно
      </button>
    </div>
  )
}

function DayPhotoStrip({
  looks,
  activeId,
  onSelect,
  badge,
}: {
  looks: Look[]
  activeId: string
  onSelect: (id: string) => void
  badge?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  if (looks.length === 1) {
    return (
      <div className="look-thumb">
        <Photo blob={looks[0].photoBlob} alt={`Лук ${looks[0].date}`} />
        {badge ? <span className="match-badge">{badge}</span> : null}
      </div>
    )
  }

  return (
    <div className="day-media">
      <div className="day-swipe" ref={scrollRef}>
        {looks.map((look) => (
          <button
            key={look.id}
            type="button"
            className="day-swipe-slide"
            data-active={look.id === activeId}
            onClick={() => onSelect(look.id)}
            aria-label={look.time ? `лук в ${look.time}` : 'лук'}
          >
            <Photo blob={look.photoBlob} alt="" />
          </button>
        ))}
      </div>
      <div className="day-thumbs">
        {looks.map((look) => (
          <button
            key={look.id}
            type="button"
            className="day-thumb"
            data-active={look.id === activeId}
            onClick={() => onSelect(look.id)}
          >
            <Photo blob={look.photoBlob} alt="" />
          </button>
        ))}
      </div>
      {badge ? <span className="match-badge day-badge">{badge}</span> : null}
    </div>
  )
}

function DayLookCard({
  group,
  badge,
  reason,
  onFeedback,
  onFeedbackNote,
  actions,
  style,
}: {
  group: DayGroup
  badge?: string
  reason?: string
  onFeedback: (id: string, f: Feedback) => void
  onFeedbackNote?: (id: string, note: string) => void
  actions?: (active: Look) => ReactNode
  style?: CSSProperties
}) {
  const [activeId, setActiveId] = useState(group.primary.id)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setActiveId(group.primary.id)
  }, [group.date, group.primary.id])

  const active =
    group.looks.find((l) => l.id === activeId) ?? group.primary
  const place = placeSummary(group)
  const multi = group.looks.length > 1

  return (
    <article className="look-card day-card" style={style}>
      <DayPhotoStrip
        looks={group.looks}
        activeId={active.id}
        onSelect={(id) => {
          setActiveId(id)
          if (multi) setExpanded(true)
        }}
        badge={badge}
      />
      <div className="look-card-body">
        <h3>
          {formatDateRu(group.date, multi ? undefined : active.time)}
          {multi ? (
            <span className="day-count"> · {group.looks.length} фото</span>
          ) : null}
        </h3>
        <p className="look-reason">
          {place}
          {reason ? ` · ${reason}` : ` · ${weatherLabel(active.weather)}`}
          {active.note ? ` · ${active.note}` : ''}
        </p>
        <ItemTagsDisplay items={active.items} />
        {multi && (
          <button
            type="button"
            className="text-btn"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'свернуть отзывы' : 'оценка по фото'}
          </button>
        )}
        {(!multi || expanded) && (
          <div className="day-feedback">
            {multi && (
              <p className="feedback-caption">
                {active.time ? `фото ${active.time}` : 'это фото'}
              </p>
            )}
            <FeedbackBar
              value={active.feedback}
              note={active.feedbackNote}
              showNote={Boolean(onFeedbackNote)}
              onChange={(f) => onFeedback(active.id, f)}
              onNoteChange={
                onFeedbackNote
                  ? (n) => onFeedbackNote(active.id, n)
                  : undefined
              }
            />
          </div>
        )}
        {actions?.(active)}
      </div>
    </article>
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
    const home: Place = {
      placeName: place.placeName,
      latitude: place.latitude,
      longitude: place.longitude,
    }
    const next: Settings = {
      ...settings,
      ...home,
      homePlace: home,
      travelPlace: undefined,
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
  onFeedbackNote,
  onAdd,
  onOpenSettings,
  onSettings,
}: {
  looks: Look[]
  settings: Settings
  onFeedback: (id: string, f: Feedback) => void
  onFeedbackNote: (id: string, note: string) => void
  onAdd: () => void
  onOpenSettings: (focus?: 'backup') => void
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
    () =>
      weather
        ? rankDayGroups(looks, weather, 8, outingTime || undefined)
        : [],
    [looks, weather, outingTime],
  )

  const tips = weather ? weatherTips(weather) : []
  const needFeedback = useMemo(() => looksNeedingFeedback(looks, 2), [looks])
  const looksForDate = useMemo(
    () => looks.filter((l) => l.date === date),
    [looks, date],
  )
  const traveling = Boolean(settings.travelPlace)

  async function dismissBackupHint() {
    const next: Settings = {
      ...settings,
      backupReminderDismissedAt: Date.now(),
    }
    await saveSettings(next)
    onSettings(next)
    setShowBackupHint(false)
  }

  async function returnHome() {
    const home = settings.homePlace
    if (!home) return
    const next: Settings = {
      ...settings,
      placeName: home.placeName,
      latitude: home.latitude,
      longitude: home.longitude,
      travelPlace: undefined,
    }
    await saveSettings(next)
    onSettings(next)
  }

  return (
    <>
      <div className="section-kicker">атмосфера</div>
      <PwaInstallHint />
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

      {traveling && (
        <div className="soft-nudge corner travel-nudge">
          <p>
            Временно: {settings.placeName}
            {settings.homePlace
              ? ` · дом — ${settings.homePlace.placeName}`
              : ''}
          </p>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void returnHome()}
          >
            вернуться домой
          </button>
        </div>
      )}

      {showBackupHint && (
        <div className="soft-nudge corner">
          <p>Пора бэкапнуть луки — в приватный Gist на GitHub.</p>
          <div className="nudge-actions">
            <button
              type="button"
              className="olive-btn"
              onClick={() => onOpenSettings('backup')}
            >
              как настроить
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

      {looksForDate.length > 0 && (
        <div className="soft-nudge corner recorded-nudge">
          <p>
            Лук уже записан
            {looksForDate.length > 1
              ? ` · ${looksForDate.length} фото`
              : looksForDate[0].time
                ? ` · ${looksForDate[0].time}`
                : ''}
          </p>
          <button type="button" className="ghost-btn" onClick={onAdd}>
            ещё фото
          </button>
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
          {tips.map((tip) => (
            <p key={tip} className="rain-tip">
              {tip}
            </p>
          ))}
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
          <button
            type="button"
            className="ghost-btn"
            onClick={() => onOpenSettings('backup')}
          >
            как сохранить бэкап
          </button>
        </div>
      )}
      {weather && !loading && looks.length > 0 && ranked.length === 0 && (
        <p className="empty">
          Нет луков за другие дни — добавь ещё образы, чтобы сравнить погоду.
        </p>
      )}
      <div className="look-grid">
        {ranked.map((group, i) => (
          <DayLookCard
            key={group.date}
            group={group}
            badge={`${group.matchPercent}%`}
            reason={group.reason}
            onFeedback={onFeedback}
            onFeedbackNote={onFeedbackNote}
            style={{ animationDelay: `${i * 50}ms` }}
          />
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
  const [items, setItems] = useState<ItemTag[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [weather, setWeather] = useState<WeatherProfile | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingFeedback, setPendingFeedback] = useState<Look | null>(null)
  const [pendingNote, setPendingNote] = useState('')

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
        items: items.length ? items : undefined,
        photoBlob: blob,
        weather,
        placeName: place.placeName,
        latitude: place.latitude,
        longitude: place.longitude,
        locationSource: place.source,
      }
      await addLook(look)
      scheduleAutoBackup('look')
      setNote('')
      setItems([])
      setBlob(null)
      setTime('')
      setTakenAt(undefined)
      setMetaSource(null)
      setPlace({ ...settings, source: 'settings' })
      if (preview) URL.revokeObjectURL(preview)
      setPreview(null)
      setStatus(null)
      setPendingNote('')
      setPendingFeedback(look)
    } catch {
      setError('Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function finishFeedback(f?: Feedback) {
    if (pendingFeedback && f) {
      await updateLookFeedback(
        pendingFeedback.id,
        f,
        pendingNote.trim() || undefined,
      )
      scheduleAutoBackup('feedback')
    }
    setPendingFeedback(null)
    setPendingNote('')
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
            note={pendingNote}
            showNote
            onChange={(f) => void finishFeedback(f)}
            onNoteChange={setPendingNote}
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
        <ItemTagsPicker value={items} onChange={setItems} />
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
            placeholder="пальто / кроссовки…"
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
  onFeedbackNote,
  onDelete,
  onUpdated,
  onAdd,
}: {
  looks: Look[]
  settings: Settings
  onFeedback: (id: string, f: Feedback) => void
  onFeedbackNote: (id: string, note: string) => void
  onDelete: (id: string) => void
  onUpdated: () => void
  onAdd: () => void
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [locBusy, setLocBusy] = useState(false)
  const [locError, setLocError] = useState<string | null>(null)

  const dayGroups = useMemo(() => groupLooksByDate(looks), [looks])

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
      scheduleAutoBackup('place')
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
        {dayGroups.map((group) => (
          <DayLookCard
            key={group.date}
            group={group}
            badge={formatFeels(group.primary.weather.feelsLike)}
            onFeedback={onFeedback}
            onFeedbackNote={onFeedbackNote}
            actions={(active) => {
              const place: PlaceState = {
                placeName: active.placeName || settings.placeName,
                latitude: active.latitude ?? settings.latitude,
                longitude: active.longitude ?? settings.longitude,
                source: active.locationSource ?? 'settings',
              }
              return (
                <>
                  {editingId === active.id ? (
                    <>
                      <LocationEditor
                        place={place}
                        compact
                        onChange={(next) => void applyPlace(active, next)}
                      />
                      {locBusy && (
                        <p className="status loading-pulse">
                          обновляю погоду…
                        </p>
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
                          setEditingId(active.id)
                          setLocError(null)
                        }}
                      >
                        место
                      </button>
                      {pendingDelete === active.id ? null : (
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() => setPendingDelete(active.id)}
                        >
                          удалить
                        </button>
                      )}
                    </div>
                  )}
                  {pendingDelete === active.id && (
                    <div className="confirm-bar">
                      <p>удалить это фото?</p>
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
                          onDelete(active.id)
                          setPendingDelete(null)
                        }}
                      >
                        удалить
                      </button>
                    </div>
                  )}
                </>
              )
            }}
          />
        ))}
      </div>
    </>
  )
}

function BackupSetupGuide({ open }: { open: boolean }) {
  const [expanded, setExpanded] = useState(open)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setExpanded(true)
      requestAnimationFrame(() => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }, [open])

  return (
    <div className="backup-guide" ref={ref} id="backup-guide">
      <button
        type="button"
        className="backup-guide-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="section-kicker">инструкция</span>
        <span className="backup-guide-title">
          как настроить бэкап
          <span className="backup-guide-chevron" data-open={expanded}>
            ▾
          </span>
        </span>
      </button>
      {expanded && (
        <ol className="backup-guide-steps">
          <li>
            <strong>Токен на GitHub.</strong> Открой{' '}
            <a
              href="https://github.com/settings/tokens/new"
              target="_blank"
              rel="noreferrer"
            >
              github.com/settings/tokens/new
            </a>
            . Войди в аккаунт. Note — любое имя, например «look». Срок — можно
            без срока. Галочка только <code>gist</code>. Generate token →
            скопируй (потом не покажут).
          </li>
          <li>
            <strong>Вставь сюда.</strong> Поле «GitHub PAT» ниже → вставь →
            «сохранить токен». Включи «автобэкап».
          </li>
          <li>
            <strong>Что происходит.</strong> Луки уходят в приватный Gist — не
            в публичный репозиторий look-weather. Токен остаётся только на
            этом телефоне.
          </li>
          <li>
            <strong>Новый телефон.</strong> Открой look. → «ещё» → вставь тот
            же токен → «восстановить из GitHub». Локальные луки не сотрутся:
            совпадения по id обновятся, остальные останутся.
          </li>
        </ol>
      )}
    </div>
  )
}

function SettingsScreen({
  settings,
  looksCount,
  onSettings,
  focusBackup = false,
}: {
  settings: Settings
  looksCount: number
  onSettings: (s: Settings) => void
  focusBackup?: boolean
}) {
  const [place, setPlace] = useState<PlaceState>({
    ...settings,
    source: 'settings',
  })
  const [travelMode, setTravelMode] = useState(false)
  const [token, setToken] = useState(settings.githubToken ?? '')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPlace({ ...settings, source: 'settings' })
    setToken(settings.githubToken ?? '')
  }, [settings])

  async function persistHome(next: PlaceState) {
    setPlace(next)
    const home: Place = {
      placeName: next.placeName,
      latitude: next.latitude,
      longitude: next.longitude,
    }
    const saved: Settings = settings.travelPlace
      ? {
          ...settings,
          homePlace: home,
          cityConfirmed: true,
        }
      : {
          ...settings,
          ...home,
          homePlace: home,
          travelPlace: undefined,
          cityConfirmed: true,
        }
    // If not traveling, active city = home
    if (!settings.travelPlace) {
      saved.placeName = home.placeName
      saved.latitude = home.latitude
      saved.longitude = home.longitude
    }
    await saveSettings(saved)
    onSettings(saved)
    scheduleAutoBackup('settings')
    setStatus(`домашний город: ${next.placeName}`)
    setError(null)
    setTravelMode(false)
  }

  async function persistTravel(next: PlaceState) {
    const home =
      settings.homePlace ??
      ({
        placeName: settings.placeName,
        latitude: settings.latitude,
        longitude: settings.longitude,
      } satisfies Place)
    const travel: Place = {
      placeName: next.placeName,
      latitude: next.latitude,
      longitude: next.longitude,
    }
    const saved: Settings = {
      ...settings,
      homePlace: home,
      travelPlace: travel,
      placeName: travel.placeName,
      latitude: travel.latitude,
      longitude: travel.longitude,
      cityConfirmed: true,
    }
    setPlace({ ...travel, source: next.source })
    await saveSettings(saved)
    onSettings(saved)
    scheduleAutoBackup('settings')
    setStatus(`временно: ${next.placeName}`)
    setError(null)
    setTravelMode(false)
  }

  async function returnHome() {
    const home = settings.homePlace
    if (!home) return
    const saved: Settings = {
      ...settings,
      placeName: home.placeName,
      latitude: home.latitude,
      longitude: home.longitude,
      travelPlace: undefined,
    }
    setPlace({ ...home, source: 'settings' })
    await saveSettings(saved)
    onSettings(saved)
    setStatus(`дома: ${home.placeName}`)
    setError(null)
  }

  async function saveToken() {
    const trimmed = token.trim()
    const next: Settings = {
      ...settings,
      githubToken: trimmed || undefined,
      githubAutoBackup: trimmed
        ? (settings.githubAutoBackup ?? true)
        : settings.githubAutoBackup,
    }
    await saveSettings(next)
    onSettings(next)
    setStatus(
      trimmed
        ? 'токен сохранён на этом телефоне'
        : 'токен удалён с телефона',
    )
    setError(null)
  }

  async function setAutoBackup(on: boolean) {
    const next: Settings = {
      ...settings,
      githubAutoBackup: on,
    }
    await saveSettings(next)
    onSettings(next)
    setStatus(on ? 'автобэкап включён' : 'автобэкап выключен')
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
      const result = await importBackupFile(file)
      suppressAutoBackup()
      setStatus(
        `слито луков: ${result.imported} · всего в архиве: ${result.total}`,
      )
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
      const result = await restoreBackupFromGithub()
      suppressAutoBackup()
      setStatus(
        `восстановлено: ${result.imported} · всего: ${result.total}`,
      )
      window.location.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const autoOn = isAutoBackupEnabled(settings)
  const traveling = Boolean(settings.travelPlace)
  const homeLabel =
    settings.homePlace?.placeName ??
    (traveling ? 'не задан' : settings.placeName)

  return (
    <>
      <div className="section-kicker">настройки</div>
      <h2 className="block-title">город и бэкап</h2>
      <div className="settings-stack">
        <p>
          Домашний город — для «сегодня» и луков без GPS. В поездке можно
          временно сменить город, не теряя домашний.
        </p>
        <p className="meta-chip">
          сейчас · {settings.placeName}
          {traveling ? ' · в поездке' : ''}
        </p>
        <p className="field-hint">дом · {homeLabel}</p>

        {!travelMode ? (
          <>
            <LocationEditor
              place={
                traveling && settings.homePlace
                  ? { ...settings.homePlace, source: 'settings' }
                  : place
              }
              onChange={(next) => void persistHome(next)}
            />
            <div className="settings-actions">
              {traveling ? (
                <button
                  type="button"
                  className="olive-btn"
                  onClick={() => void returnHome()}
                >
                  вернуться домой
                </button>
              ) : (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setTravelMode(true)}
                >
                  временно другой город
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="travel-editor">
            <p className="status">Куда едешь? Домашний город сохранится.</p>
            <LocationEditor
              place={place}
              onChange={(next) => void persistTravel(next)}
            />
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setTravelMode(false)}
            >
              отмена
            </button>
          </div>
        )}

        <h3 className="settings-sub">бэкап в GitHub</h3>
        <BackupSetupGuide open={focusBackup} />

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
          Нужно право <code>gist</code>.
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
        <label className="auto-backup-row">
          <input
            type="checkbox"
            checked={autoOn}
            disabled={!settings.githubToken?.trim()}
            onChange={(e) => void setAutoBackup(e.target.checked)}
          />
          <span>
            автобэкап
            <span className="field-hint">
              {settings.githubToken?.trim()
                ? 'После новых луков и правок — в тот же Gist, в фоне.'
                : 'Сначала сохрани токен.'}
            </span>
          </span>
        </label>
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
        <p className="field-hint">
          Импорт сливает по id: старые локальные луки не пропадают.
        </p>
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

function autoBackupToastText(status: AutoBackupStatus): string | null {
  if (status.kind === 'saving') return 'бэкап…'
  if (status.kind === 'ok') return status.message
  if (status.kind === 'error') return status.message
  return null
}

export default function App() {
  const [tab, setTab] = useState<Tab>('today')
  const [settingsFocus, setSettingsFocus] = useState<'backup' | undefined>()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [autoStatus, setAutoStatus] = useState(getAutoBackupStatus)
  const { looks, refresh } = useLooks()

  useEffect(() => {
    void getSettings().then(setSettings)
  }, [])

  useEffect(() => {
    return subscribeAutoBackup((status) => {
      setAutoStatus(status)
      if (status.kind === 'ok') {
        void getSettings().then(setSettings)
      }
    })
  }, [])

  async function onFeedback(id: string, feedback: Feedback) {
    await updateLookFeedback(id, feedback)
    scheduleAutoBackup('feedback')
    await refresh()
  }

  async function onFeedbackNote(id: string, note: string) {
    const look = looks.find((l) => l.id === id)
    if (!look?.feedback) {
      await updateLook(id, { feedbackNote: note.trim() || undefined })
    } else {
      await updateLookFeedback(id, look.feedback, note.trim() || undefined)
    }
    scheduleAutoBackup('feedback')
    await refresh()
  }

  async function onDelete(id: string) {
    await deleteLook(id)
    await refresh()
  }

  function openSettings(focus?: 'backup') {
    setSettingsFocus(focus)
    setTab('settings')
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
  const backupToast = autoBackupToastText(autoStatus)

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
            onFeedbackNote={onFeedbackNote}
            onAdd={() => setTab('add')}
            onOpenSettings={openSettings}
            onSettings={setSettings}
          />
        )}
        {tab === 'add' && (
          <AddLookScreen
            settings={settings}
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
            onFeedbackNote={onFeedbackNote}
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
            focusBackup={settingsFocus === 'backup'}
          />
        )}
      </div>

      {backupToast && (
        <p
          className={
            autoStatus.kind === 'error'
              ? 'backup-toast is-error'
              : 'backup-toast'
          }
          aria-live="polite"
        >
          {backupToast}
        </p>
      )}

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
            onClick={() => {
              if (id === 'settings') {
                setSettingsFocus(undefined)
              }
              setTab(id)
            }}
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
