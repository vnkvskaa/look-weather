import { getSettings, listLooks, saveSettings } from '../db'
import type { Settings } from '../types'
import {
  buildBackup,
  importBackupPayload,
  markBackupDone,
  type BackupPayload,
} from './backup'

const GIST_FILENAME = 'look-weather-backup.json'
/** Soft limit — private gists struggle past a few MB */
const GIST_SOFT_BYTES = 2.8 * 1024 * 1024
const GIST_HARD_BYTES = 4.5 * 1024 * 1024

type GistFile = { content?: string; filename?: string }
type GistResponse = {
  id: string
  html_url?: string
  files?: Record<string, GistFile>
  message?: string
}

function authHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token.trim()}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}

async function buildSizedBackup(): Promise<{
  json: string
  recompressed: boolean
}> {
  let payload = await buildBackup()
  let json = JSON.stringify(payload)
  let recompressed = false

  if (json.length > GIST_SOFT_BYTES) {
    payload = await buildBackup({
      recompress: { maxSide: 900, quality: 0.62 },
    })
    json = JSON.stringify(payload)
    recompressed = true
  }

  if (json.length > GIST_HARD_BYTES) {
    throw new Error(
      'Бэкап слишком большой для Gist. Экспортируй в файлы или сократи архив.',
    )
  }

  return { json, recompressed }
}

export type GithubBackupResult = {
  gistId: string
  recompressed: boolean
  bytes: number
}

/** Create or PATCH the same private gist. */
export async function saveBackupToGithub(): Promise<GithubBackupResult> {
  const settings = await getSettings()
  const token = settings.githubToken?.trim()
  if (!token) {
    throw new Error('Сначала вставь GitHub-токен в настройках')
  }

  const { json, recompressed } = await buildSizedBackup()
  const body = {
    description: 'look-weather private backup',
    public: false,
    files: {
      [GIST_FILENAME]: { content: json },
    },
  }

  const gistId = settings.githubGistId?.trim()
  const url = gistId
    ? `https://api.github.com/gists/${gistId}`
    : 'https://api.github.com/gists'
  const res = await fetch(url, {
    method: gistId ? 'PATCH' : 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as GistResponse
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Токен не принят. Нужен classic PAT с правом gist (или fine-grained на gists).',
      )
    }
    if (res.status === 404 && gistId) {
      // Stale id — create a new private gist
      const created = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
      })
      if (!created.ok) {
        throw new Error('Не удалось создать gist')
      }
      const data = (await created.json()) as GistResponse
      return finishSave(settings, data.id, recompressed, json.length)
    }
    throw new Error(err.message || `GitHub: ${res.status}`)
  }

  const data = (await res.json()) as GistResponse
  return finishSave(settings, data.id, recompressed, json.length)
}

async function finishSave(
  settings: Settings,
  gistId: string,
  recompressed: boolean,
  bytes: number,
): Promise<GithubBackupResult> {
  const looks = await listLooks()
  const next = await markBackupDone(looks.length)
  await saveSettings({
    ...next,
    githubToken: settings.githubToken,
    githubGistId: gistId,
  })
  return { gistId, recompressed, bytes }
}

export async function restoreBackupFromGithub(): Promise<{
  imported: number
  total: number
}> {
  const settings = await getSettings()
  const token = settings.githubToken?.trim()
  const gistId = settings.githubGistId?.trim()
  if (!token) {
    throw new Error('Сначала вставь GitHub-токен')
  }
  if (!gistId) {
    throw new Error('Пока нет сохранённого gist — сначала сохрани бэкап')
  }

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: authHeaders(token),
  })
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('Gist не найден — проверь id или сохрани заново')
    }
    throw new Error(`Не удалось прочитать gist (${res.status})`)
  }

  const data = (await res.json()) as GistResponse
  const file =
    data.files?.[GIST_FILENAME] ??
    Object.values(data.files ?? {})[0]
  if (!file?.content) {
    throw new Error('В gist нет файла бэкапа')
  }

  // Large files may need a raw_url fetch — GitHub truncates sometimes
  let text = file.content
  const raw = (file as GistFile & { raw_url?: string; truncated?: boolean })
    .raw_url
  const truncated = (file as GistFile & { truncated?: boolean }).truncated
  if (truncated && raw) {
    const rawRes = await fetch(raw, {
      headers: { Authorization: `Bearer ${token.trim()}` },
    })
    if (!rawRes.ok) throw new Error('Не удалось скачать полный gist')
    text = await rawRes.text()
  }

  const payload = JSON.parse(text) as BackupPayload
  return importBackupPayload(payload)
}
