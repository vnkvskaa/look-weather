import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  addLook,
  deleteLook,
  estimateStorage,
  getLookFullBlob,
  getLookThumbBlob,
  getSettings,
  isStorageLow,
  listLooksMeta,
  recompressAllPhotos,
  saveSettings,
  updateLook,
  updateLookFeedback,
  type StorageEstimate,
} from './db'
import {
  importBackupFile,
  shareOrDownloadBackup,
  shareOrDownloadFullBackup,
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
  GITHUB_TOKEN_CREATE_URL,
  NEED_NEW_KEY_BODY,
  NEED_NEW_KEY_TITLE,
  ensureBackupMigration,
  githubSaveStatusMessage,
  isGithubAccessError,
  needsNewGithubKey,
  planGithubBackup,
  restoreBackupFromGithub,
  saveBackupToGithub,
  validateGithubToken,
  verifyGithubBackup,
} from './looks/githubBackup'
import {
  extractPhotoMeta,
  formatBytes,
  getLookObjectUrl,
  isQuotaExceededError,
  prepareLookImages,
  pruneLookObjectUrls,
  QUOTA_HINT,
  revokeLookObjectUrl,
} from './looks/media'
import { importLooksBatch } from './looks/importLook'
import {
  filterDayGroupsByTempBucket,
  formatMonthChip,
  formatMonthHeader,
  groupDayGroupsByMonth,
  groupLooksByDate,
  listMonthsFromLooks,
  sortDayGroupsByFeelsLike,
  TEMP_BUCKETS,
  type TempBucketId,
} from './looks/dayGroups'
import {
  isThinAdvice,
  looksNeedingFeedback,
  matchDeltaLabel,
  rankDayGroups,
  splitPrimaryAdvice,
  THIN_ADVICE_COPY,
  weatherTips,
} from './looks/recommend'
import type {
  DayGroup,
  Feedback,
  LocationSource,
  Look,
  Place,
  Settings,
  Tab,
  WeatherProfile,
} from './types'
import { FEEDBACK_STEPS } from './types'
import {
  fetchWeatherForDate,
  formatFeels,
  formatPlaceShort,
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

function lookCountLabel(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} лук`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return `${n} лука`
  }
  return `${n} луков`
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
  const refresh = async () => {
    const next = await listLooksMeta()
    pruneLookObjectUrls(new Set(next.map((l) => l.id)))
    setLooks(next)
  }
  useEffect(() => {
    void refresh()
  }, [])
  return { looks, refresh }
}

function PhotoLightbox({
  lookId,
  alt,
  onClose,
}: {
  lookId: string
  alt: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    const prevTouch = document.body.style.touchAction
    document.body.style.overflow = 'hidden'
    document.body.style.touchAction = 'none'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      document.body.style.touchAction = prevTouch
    }
  }, [onClose])

  return createPortal(
    <div
      className="photo-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'фото лука'}
      onClick={onClose}
    >
      <button
        type="button"
        className="photo-lightbox-close"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="закрыть"
      >
        закрыть
      </button>
      <div
        className="photo-lightbox-photo"
        onClick={(e) => e.stopPropagation()}
      >
        <Photo lookId={lookId} alt={alt} variant="full" />
      </div>
    </div>,
    document.body,
  )
}

function Photo({
  lookId,
  alt,
  variant = 'thumb',
}: {
  lookId: string
  alt: string
  /** Lists use thumb; large preview can request full. */
  variant?: 'thumb' | 'full'
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setMissing(false)
    void (async () => {
      const blob =
        variant === 'full'
          ? await getLookFullBlob(lookId)
          : await getLookThumbBlob(lookId)
      if (cancelled) return
      if (!blob) {
        setMissing(true)
        return
      }
      setUrl(getLookObjectUrl(lookId, blob, variant))
    })()
    return () => {
      cancelled = true
    }
  }, [lookId, variant])

  if (missing) {
    return (
      <div className="photo-missing" role="img" aria-label="нет фото">
        нет фото
      </div>
    )
  }
  if (!url) {
    return <div className="photo-skeleton" aria-hidden />
  }
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
  const index = value
    ? FEEDBACK_STEPS.findIndex((s) => s.id === value)
    : -1
  const [draft, setDraft] = useState(note ?? '')
  const focusedRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) setDraft(note ?? '')
  }, [note])

  return (
    <div className="feedback-block">
      <p className="feedback-caption">в этой одежде</p>
      <div
        className="feedback-scale"
        role="radiogroup"
        aria-label="Ощущение в этой одежде"
      >
        <div className="feedback-track" aria-hidden>
          <span
            className="feedback-track-fill"
            style={{
              width:
                index >= 0
                  ? `${(index / (FEEDBACK_STEPS.length - 1)) * 100}%`
                  : '0%',
            }}
          />
        </div>
        <div className="feedback-steps">
          {FEEDBACK_STEPS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={value === item.id}
              data-active={value === item.id}
              onClick={() => onChange(item.id)}
            >
              <span className="feedback-dot" aria-hidden />
              <span className="feedback-step-label">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
      {showNote && onNoteChange && (
        <input
          className="feedback-note"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 80))}
          onFocus={() => {
            focusedRef.current = true
          }}
          onBlur={() => {
            focusedRef.current = false
            onNoteChange(draft)
          }}
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

function FavoriteButton({
  active,
  onToggle,
}: {
  active?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="favorite-btn"
      data-active={active === true}
      aria-pressed={active === true}
      aria-label={active ? 'убрать из избранного' : 'в избранное'}
      onClick={onToggle}
    >
      <span aria-hidden>{active ? '★' : '☆'}</span>
    </button>
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
        На экран «Домой»: Поделиться → На экран «Домой».
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
  favorite,
}: {
  looks: Look[]
  activeId: string
  onSelect: (id: string) => void
  badge?: string
  favorite?: boolean
}) {
  const active = looks.find((l) => l.id === activeId) ?? looks[0]
  const multi = looks.length > 1
  const [lightboxId, setLightboxId] = useState<string | null>(null)
  const alt = `Лук ${active.date}${active.time ? ` ${active.time}` : ''}`
  const lightboxLook =
    looks.find((l) => l.id === lightboxId) ?? (lightboxId ? active : null)

  return (
    <div className={multi ? 'day-media' : undefined}>
      <button
        type="button"
        className="look-thumb look-thumb-open"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setLightboxId(active.id)
        }}
        aria-label="открыть фото"
      >
        <Photo lookId={active.id} alt={alt} variant="thumb" />
        {badge ? <span className="match-badge">{badge}</span> : null}
        {favorite ? (
          <span className="favorite-mark" aria-hidden>
            ★
          </span>
        ) : null}
      </button>
      {multi ? (
        <div className="day-thumbs" role="tablist" aria-label="фото за день">
          {looks.map((look) => (
            <button
              key={look.id}
              type="button"
              role="tab"
              className="day-thumb"
              aria-selected={look.id === active.id}
              data-active={look.id === active.id}
              data-favorite={look.favorite === true}
              onClick={() => {
                if (look.id === active.id) {
                  setLightboxId(look.id)
                  return
                }
                onSelect(look.id)
              }}
            >
              <Photo lookId={look.id} alt="" variant="thumb" />
            </button>
          ))}
        </div>
      ) : null}
      {lightboxLook ? (
        <PhotoLightbox
          lookId={lightboxLook.id}
          alt={`Лук ${lightboxLook.date}${lightboxLook.time ? ` ${lightboxLook.time}` : ''}`}
          onClose={() => setLightboxId(null)}
        />
      ) : null}
    </div>
  )
}

function DayLookCard({
  group,
  badge,
  reason,
  onFeedback,
  onFeedbackNote,
  onFavorite,
  actions,
  style,
  density = 'compact',
}: {
  group: DayGroup
  badge?: string
  reason?: string
  onFeedback: (id: string, f: Feedback) => void
  onFeedbackNote?: (id: string, note: string) => void
  onFavorite?: (id: string, favorite: boolean) => void
  actions?: (active: Look) => ReactNode
  style?: CSSProperties
  /** compact — list row; featured — slightly larger for «лучше всего» */
  density?: 'compact' | 'featured'
}) {
  const [activeId, setActiveId] = useState(group.primary.id)

  useEffect(() => {
    setActiveId(group.primary.id)
  }, [group.date, group.primary.id])

  const active =
    group.looks.find((l) => l.id === activeId) ?? group.primary
  const place = formatPlaceShort(active.placeName)
  const multi = group.looks.length > 1

  return (
    <article
      className={`look-card day-card look-card-${density}`}
      style={style}
    >
      <DayPhotoStrip
        looks={group.looks}
        activeId={active.id}
        onSelect={setActiveId}
        badge={badge}
        favorite={active.favorite}
      />
      <div className="look-card-body">
        <div className="look-card-head">
          <h3>
            {formatDateRu(group.date, active.time)}
            {multi ? (
              <span className="day-count"> · {group.looks.length}</span>
            ) : null}
          </h3>
          {onFavorite ? (
            <FavoriteButton
              active={active.favorite}
              onToggle={() => onFavorite(active.id, !active.favorite)}
            />
          ) : null}
        </div>
        <p className="look-meta">
          {place}
          <span className="look-meta-sep"> · </span>
          {formatFeels(active.weather.feelsLike)}
        </p>
        {reason ? <p className="look-reason">{reason}</p> : null}
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
        setError('Не удалось определить место — найди город вручную')
        setEditing(true)
      },
      { enableHighAccuracy: false, timeout: 12000 },
    )
  }

  return (
    <div className="place-card corner">
      <p className="place-card-label">{sourceLabel(place.source)}</p>
      <p className="place-card-name">{formatPlaceShort(place.placeName)}</p>
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
        <div className="section-kicker">город</div>
        <h2 className="block-title">где ты?</h2>
        <p className="onboard-copy">
          Нужен для погоды на сегодня. Можно взять гео или найти вручную.
        </p>
        <LocationEditor place={place} onChange={setPlace} />
        <button
          type="button"
          className="olive-btn"
          disabled={saving}
          onClick={() => void confirm()}
        >
          {saving ? 'сохраняю…' : 'сохранить город'}
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
  onFavorite,
  onAdd,
  onOpenSettings,
  onSettings,
  onRefresh,
}: {
  looks: Look[]
  settings: Settings
  onFeedback: (id: string, f: Feedback) => void
  onFeedbackNote: (id: string, note: string) => void
  onFavorite: (id: string, favorite: boolean) => void
  onAdd: () => void
  onOpenSettings: (focus?: 'backup') => void
  onSettings: (s: Settings) => void
  onRefresh: () => Promise<void>
}) {
  const [date, setDate] = useState(todayISO)
  const [outingTime, setOutingTime] = useState(defaultOutingTime)
  const [weather, setWeather] = useState<WeatherProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showBackupHint, setShowBackupHint] = useState(false)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [showSimilar, setShowSimilar] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)
  const batchGalleryRef = useRef<HTMLInputElement>(null)

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

  const pool = useMemo(
    () => (favoritesOnly ? looks.filter((l) => l.favorite) : looks),
    [looks, favoritesOnly],
  )

  const ranked = useMemo(
    () =>
      weather
        ? rankDayGroups(pool, weather, 8, outingTime || undefined)
        : [],
    [pool, weather, outingTime],
  )

  const { primary, rest } = useMemo(
    () => splitPrimaryAdvice(ranked),
    [ranked],
  )

  const thinAdvice = useMemo(
    () =>
      weather
        ? isThinAdvice(pool, weather.date, primary)
        : false,
    [pool, weather, primary],
  )

  const tips = weather ? weatherTips(weather) : []
  const needFeedback = useMemo(() => looksNeedingFeedback(looks, 2), [looks])
  const looksForDate = useMemo(
    () => looks.filter((l) => l.date === date),
    [looks, date],
  )
  const hasFavorites = looks.some((l) => l.favorite)
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

  async function onBatchFiles(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : []
    if (files.length === 0) return
    setBatchError(null)
    if (await isStorageLow(Math.max(2 * 1024 * 1024, files.length * 150_000))) {
      const ok = window.confirm(
        'На устройстве мало места. Всё равно загрузить? Лучше сначала сжать старые фото в настройках.',
      )
      if (!ok) return
    }
    setBatchProgress({ done: 0, total: files.length })
    try {
      const { saved, failed, quotaHit } = await importLooksBatch(
        files,
        settings,
        (done, total) => setBatchProgress({ done, total }),
      )
      if (saved > 0) {
        scheduleAutoBackup('look')
        await onRefresh()
      }
      if (quotaHit) {
        setBatchError(QUOTA_HINT)
      } else if (failed > 0 && saved === 0) {
        setBatchError('Не удалось загрузить фото')
      } else if (failed > 0) {
        setBatchError(`загружено ${saved}, пропущено ${failed}`)
      }
    } catch {
      setBatchError('Не удалось загрузить фото')
    } finally {
      setBatchProgress(null)
      if (batchGalleryRef.current) batchGalleryRef.current.value = ''
    }
  }

  return (
    <>
      <div className="section-kicker">погода</div>
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
          hint="время выхода"
        />
      </div>

      {traveling && (
        <div className="soft-nudge corner travel-nudge">
          <p>
            Сейчас: {formatPlaceShort(settings.placeName)}
            {settings.homePlace
              ? ` · дом — ${formatPlaceShort(settings.homePlace.placeName)}`
              : ''}
          </p>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void returnHome()}
          >
            домой
          </button>
        </div>
      )}

      {looksForDate.length > 0 && (
        <div className="soft-nudge corner recorded-nudge">
          <p>
            Уже есть запись
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

      {loading && (
        <p className="status loading-pulse">загружаю погоду…</p>
      )}
      {error && <p className="error">{error}</p>}

      {weather && !loading && (
        <>
          <div className="hero-temp">
            <div className="deg">{formatFeels(weather.feelsLike)}</div>
            <div className="side">
              ощущается
              <br />
              {formatPlaceShort(settings.placeName)}
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
          по похожим дням
          {outingTime ? ` около ${outingTime}` : ''}
        </p>
      )}
      {hasFavorites && (
        <div className="control-row filter-row">
          <button
            type="button"
            className="ghost-btn"
            data-active={favoritesOnly}
            onClick={() => setFavoritesOnly((v) => !v)}
          >
            только ★
          </button>
        </div>
      )}
      {looks.length === 0 && (
        <div className="empty-actions">
          <p className="empty">
            Пока пусто. Добавь первый лук — здесь появятся подсказки.
          </p>
          <button type="button" className="olive-btn" onClick={onAdd}>
            добавить лук
          </button>
          <label className="file-btn batch-gallery-btn">
            загрузить несколько фото из галереи
            <input
              ref={batchGalleryRef}
              type="file"
              accept="image/*"
              multiple
              disabled={Boolean(batchProgress)}
              onChange={(e) => void onBatchFiles(e.target.files)}
            />
          </label>
          {batchProgress && (
            <p className="status loading-pulse">
              {batchProgress.done} из {batchProgress.total}…
            </p>
          )}
          {batchError && <p className="error">{batchError}</p>}
          <button
            type="button"
            className="ghost-btn"
            onClick={() => onOpenSettings('backup')}
          >
            как сделать копию
          </button>
        </div>
      )}
      {weather && !loading && looks.length > 0 && ranked.length === 0 && (
        <p className="empty">
          {favoritesOnly
            ? 'В избранном нет других дней — сними фильтр или отметь ★.'
            : 'Нужны луки за другие дни — добавь ещё образы.'}
        </p>
      )}
      {weather && !loading && primary && (
        <div className="advice-block">
          {thinAdvice ? (
            <p className="thin-advice">{THIN_ADVICE_COPY}</p>
          ) : (
            <p className="advice-kicker">лучше всего</p>
          )}
          <div className="look-grid advice-primary">
            <DayLookCard
              group={primary}
              density="featured"
              badge={matchDeltaLabel(
                primary.effectiveWarmth,
                weather.feelsLike,
              )}
              reason={primary.reason}
              onFeedback={onFeedback}
              onFeedbackNote={onFeedbackNote}
              onFavorite={onFavorite}
            />
          </div>
          {rest.length > 0 && (
            <div className="advice-similar">
              <button
                type="button"
                className="text-btn advice-similar-toggle"
                aria-expanded={showSimilar}
                onClick={() => setShowSimilar((v) => !v)}
              >
                {showSimilar
                  ? 'скрыть похожие'
                  : `ещё похожие · ${rest.length}`}
              </button>
              {showSimilar ? (
                <div className="look-grid advice-rest">
                  {rest.map((group, i) => (
                    <DayLookCard
                      key={group.date}
                      group={group}
                      badge={matchDeltaLabel(
                        group.effectiveWarmth,
                        weather.feelsLike,
                      )}
                      reason={group.reason}
                      onFeedback={onFeedback}
                      onFeedbackNote={onFeedbackNote}
                      onFavorite={onFavorite}
                      style={{ animationDelay: `${i * 50}ms` }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {needFeedback.length > 0 && (
        <div className="soft-nudge corner below-advice">
          <p>Как было в этой одежде?</p>
          {needFeedback.slice(0, 2).map((look) => (
            <div key={look.id} className="nudge-look">
              <div className="nudge-look-thumb">
                <Photo lookId={look.id} alt="" />
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

      {showBackupHint && (
        <div className="soft-nudge corner below-advice">
          <p>Стоит сохранить копию луков — на случай смены телефона.</p>
          <div className="nudge-actions">
            <button
              type="button"
              className="olive-btn"
              onClick={() => onOpenSettings('backup')}
            >
              настроить
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

      <div className="below-advice">
        <PwaInstallHint />
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
  const [preview, setPreview] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [weather, setWeather] = useState<WeatherProfile | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingFeedback, setPendingFeedback] = useState<Look | null>(null)
  const [pendingNote, setPendingNote] = useState('')
  const [batchProgress, setBatchProgress] = useState<{
    done: number
    total: number
  } | null>(null)

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
      const { blob: compressed } = await prepareLookImages(file)
      if (preview) URL.revokeObjectURL(preview)
      setBlob(compressed)
      setPreview(URL.createObjectURL(compressed))
      const city = formatPlaceShort(settings.placeName)
      setStatus(
        meta.source === 'exif'
          ? `снято ${formatDateRu(meta.date, meta.time)}`
          : meta.source === 'file'
            ? `дата файла ${formatDateRu(meta.date, meta.time)}`
            : meta.gps
              ? `сейчас · место с фото`
              : `сейчас · город из настроек · ${city}`,
      )
    } catch (e) {
      if (isQuotaExceededError(e)) setError(QUOTA_HINT)
      else setError('Не удалось обработать фото')
      setStatus(null)
    }
  }

  async function onGalleryFiles(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : []
    if (files.length === 0) return
    if (files.length === 1) {
      await onFile(files[0])
      return
    }
    setError(null)
    if (await isStorageLow(Math.max(2 * 1024 * 1024, files.length * 150_000))) {
      const ok = window.confirm(
        'На устройстве мало места. Всё равно загрузить? Лучше сначала сжать старые фото в настройках.',
      )
      if (!ok) {
        if (galleryRef.current) galleryRef.current.value = ''
        return
      }
    }
    setBatchProgress({ done: 0, total: files.length })
    try {
      const { saved, failed, quotaHit } = await importLooksBatch(
        files,
        settings,
        (done, total) => setBatchProgress({ done, total }),
      )
      if (saved > 0) scheduleAutoBackup('look')
      if (saved > 0) {
        onSaved()
        return
      }
      setError(
        quotaHit
          ? QUOTA_HINT
          : failed > 0
            ? 'Не удалось загрузить фото'
            : 'Не удалось сохранить',
      )
    } catch (e) {
      setError(isQuotaExceededError(e) ? QUOTA_HINT : 'Не удалось загрузить фото')
    } finally {
      setBatchProgress(null)
      if (galleryRef.current) galleryRef.current.value = ''
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
        weather,
        placeName: place.placeName,
        latitude: place.latitude,
        longitude: place.longitude,
        locationSource: place.source,
      }
      const { blob: main, thumbBlob } = await prepareLookImages(blob)
      await addLook(look, { blob: main, thumbBlob })
      scheduleAutoBackup('look')
      setNote('')
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
    } catch (e) {
      setError(isQuotaExceededError(e) ? QUOTA_HINT : 'Не удалось сохранить')
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
        <div className="section-kicker">готово</div>
        <h2 className="block-title">в этой одежде было?</h2>
        <div className="form-stack">
          <div className="photo-drop corner has-photo">
            <Photo
              lookId={pendingFeedback.id}
              alt="Сохранённый лук"
              variant="full"
            />
          </div>
          <p className="status">
            {formatDateRu(pendingFeedback.date, pendingFeedback.time)} ·{' '}
            {weatherLabel(pendingFeedback.weather)}
          </p>
          <p className="feedback-nudge-copy">без оценки совет будет хуже</p>
          <FeedbackBar
            value={pendingFeedback.feedback}
            note={pendingNote}
            showNote
            onChange={(f) => void finishFeedback(f)}
            onNoteChange={setPendingNote}
          />
          <button
            type="button"
            className="text-btn skip-feedback"
            onClick={() => void finishFeedback()}
          >
            пропустить
          </button>
        </div>
      </>
    )
  }

  if (batchProgress) {
    return (
      <>
        <div className="section-kicker">новый</div>
        <h2 className="block-title">загружаю фото</h2>
        <p className="status loading-pulse">
          {batchProgress.done} из {batchProgress.total}…
        </p>
      </>
    )
  }

  const metaLabel =
    metaSource === 'exif'
      ? 'из фото'
      : metaSource === 'file'
        ? 'из файла'
        : metaSource === 'now'
          ? 'сейчас'
          : null

  return (
    <>
      <div className="section-kicker">новый</div>
      <h2 className="block-title">записать лук</h2>
      <div className="form-stack">
        <button
          type="button"
          className={`photo-drop corner ${preview ? 'has-photo' : ''}`}
          onClick={() => galleryRef.current?.click()}
        >
          {preview && <img src={preview} alt="Превью лука" />}
          <div className="hint">
            фото
            <small>дата и место подтянутся из снимка, если есть</small>
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
              multiple
              onChange={(e) => void onGalleryFiles(e.target.files)}
            />
          </label>
        </div>
        <p className="field-hint">можно выбрать несколько фото из галереи</p>
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
            placeholder="например: пальто, кроссовки"
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
  onFavorite,
  onDelete,
  onUpdated,
  onAdd,
}: {
  looks: Look[]
  settings: Settings
  onFeedback: (id: string, f: Feedback) => void
  onFeedbackNote: (id: string, note: string) => void
  onFavorite: (id: string, favorite: boolean) => void
  onDelete: (id: string) => void
  onUpdated: () => void
  onAdd: () => void
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [locBusy, setLocBusy] = useState(false)
  const [locError, setLocError] = useState<string | null>(null)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [monthFilter, setMonthFilter] = useState<string | null>(null)
  const [tempBucket, setTempBucket] = useState<TempBucketId>('all')
  const [sortMode, setSortMode] = useState<'date' | 'temp'>('date')
  const [tempDir, setTempDir] = useState<'asc' | 'desc'>('asc')

  const pool = useMemo(
    () => (favoritesOnly ? looks.filter((l) => l.favorite) : looks),
    [looks, favoritesOnly],
  )
  const months = useMemo(() => listMonthsFromLooks(pool), [pool])

  useEffect(() => {
    if (monthFilter && !months.includes(monthFilter)) {
      setMonthFilter(null)
    }
  }, [months, monthFilter])

  const filtered = useMemo(
    () =>
      monthFilter
        ? pool.filter((l) => l.date.startsWith(monthFilter))
        : pool,
    [pool, monthFilter],
  )
  const dayGroups = useMemo(() => {
    const grouped = groupLooksByDate(filtered)
    const byBucket = filterDayGroupsByTempBucket(grouped, tempBucket)
    if (sortMode === 'temp') {
      return sortDayGroupsByFeelsLike(byBucket, tempDir)
    }
    return byBucket
  }, [filtered, tempBucket, sortMode, tempDir])
  const monthSections = useMemo(
    () => groupDayGroupsByMonth(dayGroups),
    [dayGroups],
  )
  const hasFavorites = looks.some((l) => l.favorite)
  const showMonthNav = months.length > 1
  const showArchiveNav =
    looks.length > 0 &&
    (showMonthNav || hasFavorites || looks.length > 1)
  const byTemp = sortMode === 'temp'
  const tempFilteredOut =
    looks.length > 0 && dayGroups.length === 0 && tempBucket !== 'all'

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

  function renderCardActions(active: Look) {
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
              <p className="status loading-pulse">обновляю погоду…</p>
            )}
            {locError && <p className="error">{locError}</p>}
            <button
              type="button"
              className="text-btn"
              onClick={() => setEditingId(null)}
            >
              готово
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
  }

  return (
    <>
      <div className="section-kicker">архив</div>
      <h2 className="block-title">все луки</h2>

      {showArchiveNav && (
        <div className="archive-nav">
          <div className="control-row filter-row archive-sort-row">
            <button
              type="button"
              className="ghost-btn"
              data-active={sortMode === 'date'}
              onClick={() => setSortMode('date')}
            >
              дата
            </button>
            <button
              type="button"
              className="ghost-btn"
              data-active={sortMode === 'temp'}
              onClick={() => setSortMode('temp')}
            >
              температура
            </button>
            {byTemp ? (
              <button
                type="button"
                className="ghost-btn"
                onClick={() =>
                  setTempDir((d) => (d === 'asc' ? 'desc' : 'asc'))
                }
              >
                {tempDir === 'asc' ? 'холод → тепло' : 'тепло → холод'}
              </button>
            ) : null}
          </div>
          <div
            className="archive-temps"
            role="navigation"
            aria-label="температура"
          >
            <span className="archive-temps-label">температура</span>
            {TEMP_BUCKETS.map((bucket) => (
              <button
                key={bucket.id}
                type="button"
                className="ghost-btn archive-temp-chip"
                data-active={tempBucket === bucket.id}
                onClick={() => setTempBucket(bucket.id)}
              >
                {bucket.label}
              </button>
            ))}
          </div>
          {showMonthNav && (
            <div className="archive-months" role="navigation" aria-label="месяцы">
              {monthFilter ? (
                <button
                  type="button"
                  className="ghost-btn archive-month-chip"
                  onClick={() => setMonthFilter(null)}
                >
                  все месяцы
                </button>
              ) : null}
              {months.map((ym) => (
                <button
                  key={ym}
                  type="button"
                  className="ghost-btn archive-month-chip"
                  data-active={monthFilter === ym}
                  onClick={() =>
                    setMonthFilter((cur) => (cur === ym ? null : ym))
                  }
                >
                  {formatMonthChip(ym)}
                </button>
              ))}
            </div>
          )}
          {hasFavorites && (
            <div className="control-row filter-row archive-fav-row">
              <button
                type="button"
                className="ghost-btn"
                data-active={favoritesOnly}
                onClick={() => setFavoritesOnly((v) => !v)}
              >
                только ★
              </button>
            </div>
          )}
        </div>
      )}

      {looks.length === 0 && (
        <div className="empty-actions">
          <p className="empty">Пока пусто — добавь первый лук.</p>
          <button type="button" className="olive-btn" onClick={onAdd}>
            добавить лук
          </button>
        </div>
      )}
      {looks.length > 0 && dayGroups.length === 0 && (
        <p className="empty">
          {tempFilteredOut
            ? 'В этом диапазоне пусто.'
            : favoritesOnly
              ? 'В избранном пусто — отметь ★ на карточке.'
              : 'В этом месяце пусто.'}
        </p>
      )}

      <div
        className="archive-list"
        data-has-nav={showArchiveNav ? 'true' : 'false'}
      >
        {byTemp ? (
          <div className="look-grid archive-grid">
            {dayGroups.map((group) => (
              <DayLookCard
                key={group.date}
                group={group}
                badge={formatFeels(group.primary.weather.feelsLike)}
                onFeedback={onFeedback}
                onFeedbackNote={onFeedbackNote}
                onFavorite={onFavorite}
                actions={renderCardActions}
              />
            ))}
          </div>
        ) : (
          monthSections.map(({ month, groups }) => (
            <section key={month} className="archive-month-section">
              <h3 className="archive-month-sticky">{formatMonthHeader(month)}</h3>
              <div className="look-grid archive-grid">
                {groups.map((group) => (
                  <DayLookCard
                    key={group.date}
                    group={group}
                    badge={formatFeels(group.primary.weather.feelsLike)}
                    onFeedback={onFeedback}
                    onFeedbackNote={onFeedbackNote}
                    onFavorite={onFavorite}
                    actions={renderCardActions}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </>
  )
}

function formatBackupWhen(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const time = d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
  if (sameDay) return `сегодня ${time}`
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${time}`
}

type BackupChecks = {
  account: boolean
  token: boolean
  auto: boolean
  copy: boolean
  verified: boolean
}

function backupChecks(settings: Settings): BackupChecks {
  const token = Boolean(settings.githubToken?.trim())
  const repoReady = Boolean(
    settings.githubRepoTokenValidatedAt ||
      (settings.githubRepoFullName?.trim() &&
        settings.backupSetupStep !== 'need-new-key' &&
        !settings.githubGistId?.trim()),
  )
  return {
    account: token || Boolean(settings.githubBackupVerifiedAt),
    token: token && !needsNewGithubKey(settings),
    auto: isAutoBackupEnabled(settings),
    copy: Boolean(
      settings.githubRepoFullName?.trim() &&
        (settings.lastBackupAt || settings.githubBackupVerifiedAt),
    ),
    verified: Boolean(settings.githubBackupVerifiedAt) && repoReady,
  }
}

function nextBackupGap(checks: BackupChecks, needsKey: boolean): string | null {
  if (needsKey) return 'новый ключ с правом repo'
  if (!checks.token) return 'сохранить ключ'
  if (!checks.copy) return 'сохранить первую копию'
  if (!checks.auto) return 'включить автосохранение'
  if (!checks.verified) return 'проверить копию'
  return null
}

function BackupPanel({
  settings,
  onSettings,
  openWizard,
  autoError,
  autoAccessDenied = false,
}: {
  settings: Settings
  onSettings: (s: Settings) => void
  openWizard: boolean
  autoError?: string | null
  autoAccessDenied?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const needsKey =
    needsNewGithubKey(settings) ||
    autoAccessDenied ||
    (Boolean(autoError) && isGithubAccessError(autoError ?? ''))
  const checks = backupChecks(settings)
  const gap = nextBackupGap(checks, needsKey)
  const setupDone = !needsKey && checks.token && checks.copy && checks.auto
  const hasCopy = !needsKey && checks.token && checks.copy
  const autoOn = settings.githubAutoBackup !== false
  const [wizard, setWizard] = useState(false)
  const [step, setStep] = useState(1)
  const [token, setToken] = useState(settings.githubToken ?? '')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [planLabel, setPlanLabel] = useState<string | null>(null)

  useEffect(() => {
    setToken(settings.githubToken ?? '')
  }, [settings.githubToken])

  useEffect(() => {
    if (!openWizard && !needsKey) return
    if (openWizard || needsKey) {
      setWizard(true)
      setStep(needsKey || !checks.token ? 2 : !checks.copy ? 3 : 2)
    }
    if (openWizard) {
      requestAnimationFrame(() => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }, [openWizard, needsKey, checks.token, checks.copy])

  useEffect(() => {
    if (!checks.token || needsKey) {
      setPlanLabel(null)
      return
    }
    let cancelled = false
    void planGithubBackup().then((plan) => {
      if (!cancelled) setPlanLabel(plan.label)
    })
    return () => {
      cancelled = true
    }
  }, [checks.token, needsKey, settings.lastBackupAt, settings.githubRepoFullName])

  async function persistSettings(next: Settings, msg?: string) {
    await saveSettings(next)
    onSettings(next)
    if (msg) setStatus(msg)
  }

  async function saveAndValidateToken() {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const { login, repoFullName } = await validateGithubToken(token)
      const next: Settings = {
        ...settings,
        githubToken: token.trim(),
        githubRepoFullName: repoFullName,
        githubRepoTokenValidatedAt: Date.now(),
        backupSetupStep: 'ready',
        githubGistId: undefined,
        githubAutoBackup: settings.githubAutoBackup ?? true,
      }
      await persistSettings(next, `ключ принят · ${login}`)
      setStep(3)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function runSave() {
    setBusy(true)
    setError(null)
    setStatus(null)
    setProgress(null)
    try {
      if (token.trim() && token.trim() !== (settings.githubToken ?? '')) {
        const { repoFullName } = await validateGithubToken(token)
        await saveSettings({
          ...settings,
          githubToken: token.trim(),
          githubRepoFullName: repoFullName,
          githubRepoTokenValidatedAt: Date.now(),
          backupSetupStep: 'ready',
          githubGistId: undefined,
          githubAutoBackup: true,
        })
      }
      const result = await saveBackupToGithub({
        onProgress: (p) => setProgress(p.message),
      })
      const refreshed = await getSettings()
      const next: Settings = {
        ...refreshed,
        githubAutoBackup: true,
        githubBackupVerifiedAt: Date.now(),
        githubRepoTokenValidatedAt:
          refreshed.githubRepoTokenValidatedAt ?? Date.now(),
        backupSetupStep: 'ready',
        githubGistId: undefined,
      }
      await persistSettings(next, githubSaveStatusMessage(result))
      setWizard(false)
      setProgress(null)
    } catch (e) {
      setError((e as Error).message)
      setProgress(null)
    } finally {
      setBusy(false)
    }
  }

  async function saveNow() {
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      const result = await saveBackupToGithub({
        onProgress: (p) => setProgress(p.message),
      })
      const refreshed = await getSettings()
      const next: Settings = {
        ...refreshed,
        githubBackupVerifiedAt: Date.now(),
        githubRepoTokenValidatedAt:
          refreshed.githubRepoTokenValidatedAt ?? Date.now(),
        backupSetupStep: 'ready',
        githubGistId: undefined,
      }
      onSettings(next)
      await saveSettings(next)
      setStatus(githubSaveStatusMessage(result))
      setProgress(null)
    } catch (e) {
      setError((e as Error).message)
      setProgress(null)
    } finally {
      setBusy(false)
    }
  }

  async function restoreNow() {
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      const result = await restoreBackupFromGithub({
        onProgress: (p) => setProgress(p.message),
      })
      suppressAutoBackup()
      setStatus(`восстановлено: ${result.imported}, всего ${result.total}`)
      window.location.reload()
    } catch (e) {
      setError((e as Error).message)
      setProgress(null)
    } finally {
      setBusy(false)
    }
  }

  async function runVerify() {
    setBusy(true)
    setError(null)
    try {
      const result = await verifyGithubBackup()
      const refreshed = await getSettings()
      onSettings(refreshed)
      const where = result.repoFullName
        ? ` · ${result.repoFullName}`
        : ''
      setStatus(
        result.hasCopy
          ? `проверено · ${result.login}${where}`
          : `ключ ок · ${result.login} — сохрани первую копию`,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function setAutoBackup(on: boolean) {
    const next: Settings = { ...settings, githubAutoBackup: on }
    await persistSettings(
      next,
      on ? 'автосохранение включено' : 'автосохранение выключено',
    )
  }

  const bannerKind = needsKey
    ? 'warn'
    : autoError
      ? 'warn'
      : setupDone
        ? 'ok'
        : checks.token
          ? 'progress'
          : 'idle'

  const bannerText = needsKey
    ? NEED_NEW_KEY_TITLE
    : autoError
      ? `Не удалось автосохранить: ${autoError}`
      : setupDone
        ? 'Копии с фото сохраняются сами'
        : gap
          ? `Осталось: ${gap}`
          : 'Копия ещё не настроена'

  const repoHint =
    settings.githubRepoFullName?.trim() || 'look-weather-data'

  return (
    <div className="backup-panel" ref={ref} id="backup-guide">
      <h3 className="settings-sub">запасная копия</h3>

      <div className="backup-banner" data-kind={bannerKind}>
        <p>{bannerText}</p>
        {needsKey ? (
          <>
            <p className="backup-banner-body">{NEED_NEW_KEY_BODY}</p>
            <a
              className="olive-btn backup-cta"
              href={GITHUB_TOKEN_CREATE_URL}
              target="_blank"
              rel="noreferrer"
            >
              создать ключ с правом repo
            </a>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setWizard(true)
                setStep(2)
                setError(null)
                setStatus(null)
              }}
            >
              уже есть — вставить сюда
            </button>
          </>
        ) : null}
        {setupDone && settings.lastBackupAt ? (
          <p className="backup-banner-meta">
            последняя копия: {formatBackupWhen(settings.lastBackupAt)}
            {settings.githubRepoFullName
              ? ` · ${settings.githubRepoFullName}`
              : ''}
          </p>
        ) : null}
        {!needsKey && !setupDone && !wizard ? (
          <button
            type="button"
            className="olive-btn"
            onClick={() => {
              setWizard(true)
              setStep(checks.token ? (checks.copy ? 2 : 3) : 1)
              setError(null)
              setStatus(null)
            }}
          >
            настроить
          </button>
        ) : null}
        {!needsKey && autoError ? (
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setWizard(true)
              setStep(2)
            }}
          >
            исправить
          </button>
        ) : null}
      </div>

      <ul className="backup-checklist" aria-label="статус копии">
        {(
          [
            ['account', 'аккаунт GitHub', checks.account || wizard || needsKey],
            [
              'token',
              needsKey ? 'нужен новый ключ' : 'ключ сохранён',
              needsKey ? false : checks.token,
            ],
            ['auto', 'автосохранение', checks.auto],
            ['copy', 'первая копия', checks.copy],
            ['verified', 'проверено', checks.verified],
          ] as const
        ).map(([id, label, done]) => (
          <li key={id} data-done={done}>
            <span aria-hidden>{done ? '✓' : '○'}</span>
            {label}
          </li>
        ))}
      </ul>

      {checks.token && !needsKey ? (
        <>
          <label className="auto-backup-row">
            <input
              type="checkbox"
              checked={autoOn}
              onChange={(e) => void setAutoBackup(e.target.checked)}
            />
            <span className="auto-backup-box" aria-hidden />
            <span className="auto-backup-label">автосохранение с фото</span>
          </label>
          <p className="field-hint">
            Копия лежит в закрытой папке-репозитории на твоём GitHub (
            {repoHint}): список луков и сжатые фото по одному файлу. Новые луки
            дописываются, старые не перезаливаются зря.
          </p>
          {planLabel ? <p className="meta-chip">{planLabel}</p> : null}
        </>
      ) : null}

      {wizard && (
        <div className="backup-wizard">
          <p className="backup-wizard-step">шаг {Math.min(step, 3)} из 3</p>

          {step === 1 && (
            <div className="backup-wizard-body">
              <p>
                Нужен бесплатный аккаунт на github.com. Если его нет —
                зарегистрируйся.
              </p>
              <a
                className="olive-btn backup-cta"
                href="https://github.com/login"
                target="_blank"
                rel="noreferrer"
              >
                открыть GitHub
              </a>
              <p>
                Потом создай ключ (Classic) для look. На странице обязательно
                поставь галочку <code>repo</code> — доступ к закрытым
                репозиториям. Без неё фото в закрытой папке не сохранятся.
                Сгенерируй ключ и сразу скопируй строку — её показывают один
                раз.
              </p>
              <a
                className="olive-btn backup-cta"
                href={GITHUB_TOKEN_CREATE_URL}
                target="_blank"
                rel="noreferrer"
              >
                создать ключ с правом repo
              </a>
              <button
                type="button"
                className="text-btn"
                onClick={() => setDetailsOpen((v) => !v)}
              >
                {detailsOpen ? 'скрыть подсказки' : 'как заполнить страницу'}
              </button>
              {detailsOpen ? (
                <ul className="backup-hints">
                  <li>
                    Выбери Generate new token (classic), не fine-grained
                  </li>
                  <li>Note — любое имя, например look-weather</li>
                  <li>Expiration — без срока или длинный</li>
                  <li>
                    Галочка у <code>repo</code> (полный доступ к private
                    repositories)
                  </li>
                  <li>
                    Репозиторий look-weather-data создаст само приложение —
                    вручную заводить не надо
                  </li>
                  <li>Скопируй строку ghp_… сразу</li>
                </ul>
              ) : null}
              <button
                type="button"
                className="olive-btn"
                onClick={() => setStep(2)}
              >
                ключ скопирован — дальше
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="backup-wizard-body">
              <p>
                {needsKey
                  ? 'Вставь новый ключ с галочкой repo — старый для закрытой папки не подойдёт.'
                  : 'Вставь ключ сюда — сразу проверим доступ к закрытому репозиторию.'}
              </p>
              <div className="field">
                <label htmlFor="gh-token-wiz">ключ</label>
                <input
                  id="gh-token-wiz"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="начинается с ghp_…"
                />
              </div>
              <a
                className="olive-btn backup-cta"
                href={GITHUB_TOKEN_CREATE_URL}
                target="_blank"
                rel="noreferrer"
              >
                создать ключ с правом repo
              </a>
              <button
                type="button"
                className="olive-btn"
                disabled={busy || !token.trim()}
                onClick={() => void saveAndValidateToken()}
              >
                {busy ? 'проверяю…' : 'сохранить ключ'}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setStep(1)}
              >
                назад
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="backup-wizard-body">
              <p>
                Создадим закрытый репозиторий{' '}
                <code>look-weather-data</code> на твоём GitHub и зальём туда
                луки со сжатыми фото. Первый раз может занять время — фото идут
                по одному. Потом дописываются только новые.
              </p>
              {planLabel ? <p className="meta-chip">{planLabel}</p> : null}
              {progress ? <p className="status">{progress}</p> : null}
              <button
                type="button"
                className="olive-btn"
                disabled={busy}
                onClick={() => void runSave()}
              >
                {busy ? progress || 'сохраняю…' : 'сохранить первую копию'}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setStep(2)}
              >
                назад
              </button>
            </div>
          )}

          {!needsKey ? (
            <button
              type="button"
              className="text-btn"
              onClick={() => setWizard(false)}
            >
              закрыть
            </button>
          ) : null}
        </div>
      )}

      {hasCopy && !wizard && (
        <div className="backup-ready">
          {progress ? <p className="status">{progress}</p> : null}
          <div className="settings-actions">
            <button
              type="button"
              className="olive-btn"
              disabled={busy}
              onClick={() => void saveNow()}
            >
              {busy ? progress || '…' : 'сохранить сейчас'}
            </button>
            <button
              type="button"
              className="solid-btn"
              disabled={busy}
              onClick={() => void restoreNow()}
            >
              восстановить на этом телефоне
            </button>
          </div>
          <button
            type="button"
            className="ghost-btn"
            disabled={busy}
            onClick={() => void runVerify()}
          >
            проверить копию
          </button>
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              setWizard(true)
              setStep(2)
            }}
          >
            сменить ключ
          </button>
        </div>
      )}

      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}
      <p className="field-hint">
        Ключ храни только на телефоне. На новом устройстве: вставь тот же ключ с
        правом repo → восстановить. Если локальное фото уже есть, оно не
        затирается. Новые сохранения идут в закрытый репозиторий
        look-weather-data с фото.
      </p>
    </div>
  )
}

function SettingsScreen({
  settings,
  looksCount,
  onSettings,
  focusBackup = false,
  autoError = null,
  autoAccessDenied = false,
}: {
  settings: Settings
  looksCount: number
  onSettings: (s: Settings) => void
  focusBackup?: boolean
  autoError?: string | null
  autoAccessDenied?: boolean
}) {
  const [place, setPlace] = useState<PlaceState>({
    ...settings,
    source: 'settings',
  })
  const [travelMode, setTravelMode] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storage, setStorage] = useState<StorageEstimate | null>(null)
  const [recompressing, setRecompressing] = useState(false)
  const [recompressProgress, setRecompressProgress] = useState<{
    done: number
    total: number
  } | null>(null)

  useEffect(() => {
    setPlace({ ...settings, source: 'settings' })
  }, [settings])

  useEffect(() => {
    void estimateStorage().then(setStorage)
  }, [looksCount, recompressing])

  async function refreshStorage() {
    setStorage(await estimateStorage())
  }

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
    if (!settings.travelPlace) {
      saved.placeName = home.placeName
      saved.latitude = home.latitude
      saved.longitude = home.longitude
    }
    await saveSettings(saved)
    onSettings(saved)
    scheduleAutoBackup('settings')
    setStatus(`домашний город: ${formatPlaceShort(next.placeName)}`)
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
    setStatus(`временно: ${formatPlaceShort(next.placeName)}`)
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
    setStatus(`дома: ${formatPlaceShort(home.placeName)}`)
    setError(null)
  }

  async function exportBackup() {
    setError(null)
    try {
      await shareOrDownloadBackup()
      const next = await markBackupDone(looksCount)
      onSettings(next)
      setStatus('файл готов — превью и данные')
    } catch {
      setError('Не удалось экспортировать')
    }
  }

  async function exportFullBackup() {
    setError(null)
    const ok = window.confirm(
      'Полная копия со всеми фото может быть большой и долгой. Продолжить?',
    )
    if (!ok) return
    try {
      await shareOrDownloadFullBackup()
      const next = await markBackupDone(looksCount)
      onSettings(next)
      setStatus('полная копия готова — сохрани в Файлы / iCloud')
    } catch {
      setError('Не удалось экспортировать полную копию')
    }
  }

  async function onImport(file: File | undefined) {
    if (!file) return
    setError(null)
    try {
      const result = await importBackupFile(file)
      suppressAutoBackup()
      setStatus(
        `добавлено: ${result.imported}, всего ${result.total}`,
      )
      window.location.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function runRecompress() {
    setError(null)
    setRecompressing(true)
    setRecompressProgress({ done: 0, total: 0 })
    try {
      const result = await recompressAllPhotos((done, total) =>
        setRecompressProgress({ done, total }),
      )
      await refreshStorage()
      setStatus(
        result.failed > 0
          ? `сжато ${result.done}, не вышло ${result.failed}`
          : `сжато ${result.done} фото`,
      )
    } catch (e) {
      setError(
        isQuotaExceededError(e)
          ? QUOTA_HINT
          : 'Не удалось сжать фото',
      )
    } finally {
      setRecompressing(false)
      setRecompressProgress(null)
    }
  }

  const traveling = Boolean(settings.travelPlace)
  const homeLabel = formatPlaceShort(
    settings.homePlace?.placeName ??
      (traveling ? undefined : settings.placeName),
  )
  const storageLabel =
    storage && storage.quota > 0
      ? `занято ${formatBytes(storage.usage)} из ${formatBytes(storage.quota)}`
      : storage
        ? `занято ${formatBytes(storage.usage)}`
        : null

  return (
    <>
      <div className="section-kicker">настройки</div>
      <h2 className="block-title">город и копия</h2>
      <div className="settings-stack">
        <p>
          Домашний город — для «сегодня» и луков без GPS. В поездке можно
          поставить другой город на время.
        </p>
        <p className="meta-chip">
          сейчас · {formatPlaceShort(settings.placeName)}
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
                  домой
                </button>
              ) : (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setTravelMode(true)}
                >
                  другой город на время
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="travel-editor">
            <p className="status">Куда едешь? Домашний город останется.</p>
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

        <BackupPanel
          settings={settings}
          onSettings={onSettings}
          openWizard={focusBackup}
          autoError={autoError}
          autoAccessDenied={autoAccessDenied}
        />

        <h3 className="settings-sub">память</h3>
        {storageLabel ? (
          <p className="meta-chip">{storageLabel}</p>
        ) : (
          <p className="field-hint">оценка места недоступна в этом браузере</p>
        )}
        <p className="field-hint">
          Новые фото ~1920px. В карточке — полное фото; тап открывает на весь
          экран. Уже сильно сжатые раньше кадры не станут чётче сами — загрузи
          заново, если нужно рассмотреть детали.
        </p>
        <button
          type="button"
          className="ghost-btn"
          disabled={recompressing || looksCount === 0}
          onClick={() => void runRecompress()}
        >
          {recompressing
            ? recompressProgress && recompressProgress.total > 0
              ? `сжимаю… ${recompressProgress.done}/${recompressProgress.total}`
              : 'сжимаю…'
            : 'освободить место (сжать фото)'}
        </button>

        <h3 className="settings-sub">файлы</h3>
        <p className="field-hint">
          На GitHub луки с фото лежат в закрытом репозитории. Здесь — файл на
          телефон или в iCloud: обычная копия с превью или полная со всеми
          кадрами.
        </p>
        <p className="field-hint">
          Импорт дополняет архив: локальные луки с другими id не пропадут. Если
          id совпал и фото уже есть — картинка на телефоне не затирается.
        </p>
        <button
          type="button"
          className="solid-btn"
          onClick={() => void exportBackup()}
        >
          сохранить в файлы
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void exportFullBackup()}
        >
          полная копия
        </button>
        <label className="file-btn">
          загрузить из файла
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
  if (status.kind === 'saving') return 'сохраняю копию…'
  if (status.kind === 'ok') return status.message
  if (status.kind === 'error') {
    return status.accessDenied ? NEED_NEW_KEY_TITLE : status.message
  }
  return null
}

export default function App() {
  const [tab, setTab] = useState<Tab>('today')
  const [settingsFocus, setSettingsFocus] = useState<'backup' | undefined>()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [autoStatus, setAutoStatus] = useState(getAutoBackupStatus)
  const { looks, refresh } = useLooks()

  useEffect(() => {
    void getSettings()
      .then((s) => ensureBackupMigration(s))
      .then(setSettings)
  }, [])

  useEffect(() => {
    return subscribeAutoBackup((status) => {
      setAutoStatus(status)
      if (status.kind === 'ok') {
        void getSettings().then(setSettings)
      }
      if (status.kind === 'error' && status.accessDenied) {
        void getSettings()
          .then((s) =>
            ensureBackupMigration({
              ...s,
              backupSetupStep: 'need-new-key',
              githubBackupVerifiedAt: undefined,
              githubRepoTokenValidatedAt: undefined,
            }),
          )
          .then(setSettings)
      }
    })
  }, [])

  async function onFeedback(id: string, feedback: Feedback) {
    await updateLookFeedback(id, feedback)
    scheduleAutoBackup('feedback')
    await refresh()
  }

  async function onFeedbackNote(id: string, note: string) {
    const cleaned = note.trim()
    const look = looks.find((l) => l.id === id)
    if (!look?.feedback) {
      await updateLook(id, { feedbackNote: cleaned || undefined })
    } else {
      await updateLookFeedback(id, look.feedback, cleaned || undefined)
    }
    scheduleAutoBackup('feedback')
    await refresh()
  }

  async function onFavorite(id: string, favorite: boolean) {
    await updateLook(id, { favorite: favorite || undefined })
    scheduleAutoBackup('feedback')
    await refresh()
  }

  async function onDelete(id: string) {
    await deleteLook(id)
    revokeLookObjectUrl(id)
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
  const autoError =
    autoStatus.kind === 'error' ? autoStatus.message : null
  const autoAccessDenied =
    autoStatus.kind === 'error' && Boolean(autoStatus.accessDenied)

  return (
    <div className="app">
      <div className="dot-grid" aria-hidden />
      <div className="shell">
        <header className="brand-row">
          <div className="brand">
            look<span>.</span>
          </div>
          <div className="meta-chip">{lookCountLabel(looks.length)}</div>
        </header>

        {tab === 'today' && (
          <TodayScreen
            looks={looks}
            settings={settings}
            onFeedback={onFeedback}
            onFeedbackNote={onFeedbackNote}
            onFavorite={onFavorite}
            onAdd={() => setTab('add')}
            onOpenSettings={openSettings}
            onSettings={setSettings}
            onRefresh={refresh}
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
            onFavorite={onFavorite}
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
            focusBackup={
              settingsFocus === 'backup' || needsNewGithubKey(settings)
            }
            autoError={autoError}
            autoAccessDenied={autoAccessDenied}
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
            ['settings', 'настройки'],
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
