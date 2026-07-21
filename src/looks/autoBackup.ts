import { getSettings } from '../db'
import { saveBackupToGithub } from './githubBackup'

/** Min gap between auto uploads when many changes fire quickly. */
export const AUTO_BACKUP_MIN_INTERVAL_MS = 45_000
/** Short delay after adding a look so save isn't blocked by UI. */
export const AUTO_BACKUP_LOOK_DELAY_MS = 1_500
/** Longer coalesce window for feedback / place edits. */
export const AUTO_BACKUP_CHANGE_DELAY_MS = 45_000

export type AutoBackupReason = 'look' | 'feedback' | 'place' | 'settings'

export type AutoBackupStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

type Listener = (status: AutoBackupStatus) => void

const SUPPRESS_KEY = 'look-weather-suppress-autobackup'

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let queuedReason: AutoBackupReason | null = null
let lastStartedAt = 0
let listeners = new Set<Listener>()
let current: AutoBackupStatus = { kind: 'idle' }
let clearOkTimer: ReturnType<typeof setTimeout> | null = null

function notify(status: AutoBackupStatus) {
  current = status
  for (const listener of listeners) listener(status)
}

export function getAutoBackupStatus(): AutoBackupStatus {
  return current
}

export function subscribeAutoBackup(listener: Listener): () => void {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}

/** After restore/import — skip one quiet re-upload on the next page life. */
export function suppressAutoBackup(ms = 120_000): void {
  try {
    sessionStorage.setItem(SUPPRESS_KEY, String(Date.now() + ms))
  } catch {
    // private mode / unavailable — ignore
  }
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  queuedReason = null
}

function isSuppressed(): boolean {
  try {
    const raw = sessionStorage.getItem(SUPPRESS_KEY)
    if (!raw) return false
    const until = Number(raw)
    if (!Number.isFinite(until) || Date.now() >= until) {
      sessionStorage.removeItem(SUPPRESS_KEY)
      return false
    }
    return true
  } catch {
    return false
  }
}

export function isAutoBackupEnabled(settings: {
  githubToken?: string
  githubAutoBackup?: boolean
}): boolean {
  return Boolean(settings.githubToken?.trim()) && settings.githubAutoBackup !== false
}

/**
 * Schedule a background gist upload. No-op without token / when toggled off.
 * Coalesces rapid edits; after «add look» runs sooner but still respects min interval.
 */
export function scheduleAutoBackup(reason: AutoBackupReason = 'look'): void {
  if (isSuppressed()) return

  queuedReason = reason
  if (inFlight) return

  if (timer) clearTimeout(timer)

  const since = Date.now() - lastStartedAt
  const minWait = Math.max(0, AUTO_BACKUP_MIN_INTERVAL_MS - since)
  const preferred =
    reason === 'look' ? AUTO_BACKUP_LOOK_DELAY_MS : AUTO_BACKUP_CHANGE_DELAY_MS
  const wait = Math.max(minWait, preferred)

  if (current.kind !== 'saving') {
    notify({ kind: 'pending' })
  }

  timer = setTimeout(() => {
    timer = null
    void runAutoBackup()
  }, wait)
}

async function runAutoBackup(): Promise<void> {
  if (inFlight) {
    // Re-schedule after current upload finishes
    queuedReason = queuedReason ?? 'look'
    return
  }
  if (isSuppressed()) {
    notify({ kind: 'idle' })
    return
  }

  const settings = await getSettings()
  if (!isAutoBackupEnabled(settings)) {
    queuedReason = null
    notify({ kind: 'idle' })
    return
  }

  inFlight = true
  lastStartedAt = Date.now()
  const reason = queuedReason
  queuedReason = null
  notify({ kind: 'saving' })

  try {
    const result = await saveBackupToGithub()
    notify({
      kind: 'ok',
      message: result.recompressed
        ? 'сохранено — превью'
        : 'сохранено',
    })
    if (clearOkTimer) clearTimeout(clearOkTimer)
    clearOkTimer = setTimeout(() => {
      if (current.kind === 'ok') notify({ kind: 'idle' })
    }, 4_000)
  } catch (e) {
    notify({
      kind: 'error',
      message: (e as Error).message || 'не удалось сохранить копию',
    })
  } finally {
    inFlight = false
    // Another change arrived while uploading
    if (queuedReason) {
      scheduleAutoBackup(queuedReason)
    } else if (reason && current.kind === 'error') {
      // leave error visible
    }
  }
}

/** Test helpers — reset module timers between cases. */
export function _resetAutoBackupForTests(): void {
  if (timer) clearTimeout(timer)
  if (clearOkTimer) clearTimeout(clearOkTimer)
  timer = null
  clearOkTimer = null
  inFlight = false
  queuedReason = null
  lastStartedAt = 0
  current = { kind: 'idle' }
  try {
    sessionStorage.removeItem(SUPPRESS_KEY)
  } catch {
    // ignore
  }
}
