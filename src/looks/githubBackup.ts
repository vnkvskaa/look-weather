import {
  getSettings,
  countLooks,
  saveSettings,
  listLooksMeta,
  getLookFullBlob,
  getLookPhoto,
  upsertLookMeta,
  mergeLooks,
} from '../db'
import type { Look, Settings } from '../types'
import { normalizeFeedback } from '../types'
import {
  blobToBase64,
  base64ToBlob,
  prepareLookImages,
  formatBytes,
} from './media'
import {
  importBackupPayload,
  markBackupDone,
  settingsForBackup,
  type BackupPayload,
} from './backup'

export const DEFAULT_BACKUP_REPO = 'look-weather-data'
export const GITHUB_TOKEN_CREATE_URL =
  'https://github.com/settings/tokens/new?scopes=repo&description=look-weather'

export const NEED_NEW_KEY_TITLE = 'Нужен новый ключ'
export const NEED_NEW_KEY_BODY =
  'Старый ключ умел только старую копию; для фото в закрытой папке на GitHub сделай новый ключ и поставь галочку repo (доступ к закрытым репозиториям). Старый можно удалить.'

const META_LOOKS_PATH = 'meta/looks.json'
const META_SETTINGS_PATH = 'meta/settings.json'
const GIST_FILENAME = 'look-weather-backup.json'

const REPO_SCOPE_HINT =
  'В ключе нужна галочка repo (доступ к закрытым репозиториям). Создай новый ключ и вставь сюда.'

type GistFile = { content?: string; filename?: string; raw_url?: string; truncated?: boolean }
type GistResponse = {
  id: string
  files?: Record<string, GistFile>
  message?: string
}

type ContentFile = {
  type?: string
  name?: string
  path?: string
  sha?: string
  content?: string
  encoding?: string
  message?: string
  download_url?: string
}

export type RemoteLookEntry = Look & {
  /** Size of photos/{id}.jpg last uploaded — for incremental skip */
  photoBytes?: number
}

export type RemoteLooksPayload = {
  version: 1
  updatedAt: string
  looks: RemoteLookEntry[]
}

function authHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token.trim()}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function jsonHeaders(token: string): HeadersInit {
  return {
    ...authHeaders(token),
    'Content-Type': 'application/json',
  }
}

function photoPath(lookId: string): string {
  return `photos/${lookId}.jpg`
}

function parseRepoFullName(full: string): { owner: string; repo: string } {
  const parts = full.trim().split('/').filter(Boolean)
  if (parts.length !== 2) {
    throw new Error('Неверное имя репозитория')
  }
  return { owner: parts[0], repo: parts[1] }
}

async function apiJson<T>(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...jsonHeaders(token),
      ...(init?.headers ?? {}),
    },
  })
  const data = (await res.json().catch(() => ({}))) as T
  return { ok: res.ok, status: res.status, data }
}

export type TokenCheckResult = {
  login: string
  /** Private backup repo opened or created during validation */
  repoFullName: string
}

/**
 * True when settings still look like gist-era or the PAT was never proven
 * for private repo access. Blocks «готово» / autobackup until re-validated.
 */
export function needsNewGithubKey(settings: {
  githubToken?: string
  githubGistId?: string
  githubRepoFullName?: string
  githubRepoTokenValidatedAt?: number
  backupSetupStep?: 'need-new-key' | 'ready'
}): boolean {
  if (settings.githubRepoTokenValidatedAt) return false
  if (settings.backupSetupStep === 'need-new-key') return true

  const token = Boolean(settings.githubToken?.trim())
  const gist = Boolean(settings.githubGistId?.trim())
  const repo = Boolean(settings.githubRepoFullName?.trim())

  if (gist) return true
  if (token && !repo) return true
  return false
}

/** 401 / 403 / 404 (or Russian scope errors) — show «Нужен новый ключ». */
export function isGithubAccessError(message: string): boolean {
  const m = message.toLowerCase()
  if (/\b(401|403|404)\b/.test(m)) return true
  if (m.includes('ключ не подошёл')) return true
  if (m.includes('нет доступа')) return true
  if (m.includes('галочка repo')) return true
  if (m.includes('нужна галочка')) return true
  if (m.includes('не удалось создать папку')) return true
  if (m.includes('не удалось создать закрытый')) return true
  return false
}

/**
 * Persist migration gate for gist-era / unvalidated tokens.
 * Idempotent — safe to call on every settings load.
 */
export async function ensureBackupMigration(
  settings: Settings,
): Promise<Settings> {
  if (!needsNewGithubKey(settings)) {
    if (
      settings.backupSetupStep === 'need-new-key' &&
      settings.githubRepoTokenValidatedAt
    ) {
      const next: Settings = { ...settings, backupSetupStep: 'ready' }
      await saveSettings(next)
      return next
    }
    return settings
  }
  if (
    settings.backupSetupStep === 'need-new-key' &&
    !settings.githubBackupVerifiedAt
  ) {
    return settings
  }
  const next: Settings = {
    ...settings,
    backupSetupStep: 'need-new-key',
    githubBackupVerifiedAt: undefined,
  }
  await saveSettings(next)
  return next
}

/**
 * Prove PAT works: GET /user, then create/open private look-weather-data.
 * Rejects gist-only tokens with a clear Russian error.
 */
export async function validateGithubToken(
  token: string,
  options: { repoName?: string } = {},
): Promise<TokenCheckResult> {
  const trimmed = token.trim()
  if (!trimmed) {
    throw new Error('Вставь ключ в поле')
  }
  if (!trimmed.startsWith('ghp_') && !trimmed.startsWith('github_pat_')) {
    throw new Error(
      'Это не похоже на ключ GitHub. Он обычно начинается с ghp_',
    )
  }

  const { ok, status, data } = await apiJson<{ login?: string; message?: string }>(
    'https://api.github.com/user',
    trimmed,
  )
  if (status === 401 || status === 403) {
    throw new Error(
      'Ключ не подошёл. Создай новый с доступом к закрытым репозиториям (галочка repo), скопируй сразу.',
    )
  }
  if (!ok) {
    throw new Error(`GitHub не ответил (${status}). Попробуй ещё раз.`)
  }
  if (!data.login) {
    throw new Error('Ключ не подошёл')
  }

  const repoName = options.repoName?.trim() || DEFAULT_BACKUP_REPO
  const repoFullName = await ensurePrivateRepo(trimmed, data.login, repoName)
  return { login: data.login, repoFullName }
}

async function ensurePrivateRepo(
  token: string,
  login: string,
  repoName: string,
): Promise<string> {
  const get = await apiJson<{ full_name?: string; private?: boolean; message?: string }>(
    `https://api.github.com/repos/${login}/${repoName}`,
    token,
  )
  if (get.ok && get.data.full_name) {
    return get.data.full_name
  }
  if (get.status !== 404) {
    if (get.status === 401 || get.status === 403) {
      throw new Error(REPO_SCOPE_HINT)
    }
    throw new Error(
      get.data.message || `Не удалось открыть репозиторий (${get.status})`,
    )
  }

  const created = await apiJson<{ full_name?: string; message?: string }>(
    'https://api.github.com/user/repos',
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        name: repoName,
        private: true,
        auto_init: true,
        description: 'look. — закрытая копия луков и фото',
      }),
    },
  )
  if (!created.ok || !created.data.full_name) {
    if (created.status === 401 || created.status === 403) {
      throw new Error(REPO_SCOPE_HINT)
    }
    if (created.status === 422) {
      // Race: created elsewhere
      const again = await apiJson<{ full_name?: string }>(
        `https://api.github.com/repos/${login}/${repoName}`,
        token,
      )
      if (again.ok && again.data.full_name) return again.data.full_name
    }
    throw new Error(
      created.data.message || 'Не удалось создать закрытый репозиторий',
    )
  }
  return created.data.full_name
}

function decodeBase64ToUtf8(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

async function getRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<{ sha: string; text: string } | null> {
  const { ok, status, data } = await apiJson<ContentFile>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    token,
  )
  if (status === 404) return null
  if (!ok) {
    if (status === 401 || status === 403) {
      throw new Error(REPO_SCOPE_HINT)
    }
    throw new Error(
      data.message || `Не удалось прочитать ${path} (${status})`,
    )
  }
  if (!data.content || data.encoding !== 'base64') {
    if (data.download_url) {
      const raw = await fetch(data.download_url, {
        headers: authHeaders(token),
      })
      if (!raw.ok) throw new Error(`Не удалось скачать ${path}`)
      return { sha: data.sha ?? '', text: await raw.text() }
    }
    return null
  }
  const text = decodeBase64ToUtf8(data.content)
  return { sha: data.sha ?? '', text }
}

async function putRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  rawBytesBase64: string,
  message: string,
  sha?: string,
): Promise<string> {
  const body: Record<string, string> = {
    message,
    content: rawBytesBase64,
  }
  if (sha) body.sha = sha

  const { ok, status, data } = await apiJson<{
    content?: { sha?: string }
    message?: string
  }>(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify(body),
  })

  if (!ok) {
    if (status === 401 || status === 403) {
      throw new Error(REPO_SCOPE_HINT)
    }
    if (status === 409 || status === 422) {
      // sha mismatch — refetch and retry once
      const latest = await getRepoFile(token, owner, repo, path)
      if (latest?.sha && latest.sha !== sha) {
        return putRepoFile(
          token,
          owner,
          repo,
          path,
          rawBytesBase64,
          message,
          latest.sha,
        )
      }
    }
    throw new Error(data.message || `Не удалось сохранить ${path} (${status})`)
  }
  return data.content?.sha ?? sha ?? ''
}

async function putRepoTextFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  text: string,
  message: string,
  sha?: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return putRepoFile(token, owner, repo, path, btoa(binary), message, sha)
}

async function listRemotePhotoIds(
  token: string,
  owner: string,
  repo: string,
): Promise<Map<string, { sha: string; size?: number }>> {
  const map = new Map<string, { sha: string; size?: number }>()
  const { ok, status, data } = await apiJson<
    ContentFile[] | ContentFile
  >(`https://api.github.com/repos/${owner}/${repo}/contents/photos`, token)
  if (status === 404) return map
  if (!ok) {
    throw new Error(
      (data as ContentFile).message ||
        `Не удалось прочитать папку photos (${status})`,
    )
  }
  const list = Array.isArray(data) ? data : []
  for (const item of list) {
    if (item.type !== 'file' || !item.name?.endsWith('.jpg')) continue
    const id = item.name.replace(/\.jpg$/i, '')
    if (item.sha) map.set(id, { sha: item.sha })
  }
  return map
}

async function downloadPhotoBlob(
  token: string,
  owner: string,
  repo: string,
  lookId: string,
): Promise<Blob | null> {
  const path = photoPath(lookId)
  const { ok, status, data } = await apiJson<ContentFile>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    token,
  )
  if (status === 404) return null
  if (!ok) {
    throw new Error(data.message || `Не скачать фото ${lookId}`)
  }
  if (data.download_url) {
    const res = await fetch(data.download_url, {
      headers: authHeaders(token),
    })
    if (!res.ok) return null
    return await res.blob()
  }
  if (data.content && data.encoding === 'base64') {
    return base64ToBlob(data.content.replace(/\n/g, ''))
  }
  return null
}

export type GithubBackupProgress = {
  phase: 'repo' | 'photos' | 'meta' | 'done'
  done: number
  total: number
  message: string
}

export type GithubBackupOptions = {
  onProgress?: (p: GithubBackupProgress) => void
  /** Override default look-weather-data */
  repoName?: string
}

export type GithubBackupResult = {
  repoFullName: string
  photosUploaded: number
  photosSkipped: number
  looksTotal: number
  bytesUploaded: number
}

/**
 * Confirm token works and private backup repo is reachable.
 * Does not treat a legacy gist as a valid configured copy.
 */
export async function verifyGithubBackup(): Promise<{
  login: string
  hasCopy: boolean
  repoFullName?: string
}> {
  const settings = await getSettings()
  const token = settings.githubToken?.trim()
  if (!token) {
    throw new Error('Сначала сохрани ключ')
  }
  const { login, repoFullName } = await validateGithubToken(token)
  let hasCopy = false

  const { owner, repo } = parseRepoFullName(repoFullName)
  const res = await apiJson<ContentFile>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${META_LOOKS_PATH}`,
    token,
  )
  if (res.status === 404) {
    // Repo exists, first copy not written yet
    hasCopy = false
  } else if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(REPO_SCOPE_HINT)
    }
    throw new Error(`Не удалось проверить копию (${res.status})`)
  } else {
    hasCopy = true
  }

  await saveSettings({
    ...settings,
    githubRepoFullName: repoFullName,
    githubRepoTokenValidatedAt: Date.now(),
    githubBackupVerifiedAt: Date.now(),
    backupSetupStep: 'ready',
    githubGistId: undefined,
  })
  return { login, hasCopy, repoFullName }
}

/** Create/update private repo backup with photos (incremental). */
export async function saveBackupToGithub(
  options: GithubBackupOptions = {},
): Promise<GithubBackupResult> {
  const settings = await getSettings()
  const token = settings.githubToken?.trim()
  if (!token) {
    throw new Error('Сначала вставь ключ от GitHub в настройках')
  }

  const onProgress = options.onProgress
  onProgress?.({
    phase: 'repo',
    done: 0,
    total: 0,
    message: 'открываю папку на GitHub…',
  })

  const { repoFullName: validatedRepo } = await validateGithubToken(token, {
    repoName:
      options.repoName?.trim() ||
      settings.githubRepoFullName?.split('/')[1] ||
      DEFAULT_BACKUP_REPO,
  })
  const repoFullName = validatedRepo
  const { owner, repo } = parseRepoFullName(repoFullName)

  const looks = await listLooksMeta()
  const remoteLooksFile = await getRepoFile(
    token,
    owner,
    repo,
    META_LOOKS_PATH,
  )
  let remoteLooks: RemoteLookEntry[] = []
  if (remoteLooksFile?.text) {
    try {
      const parsed = JSON.parse(remoteLooksFile.text) as RemoteLooksPayload
      if (Array.isArray(parsed.looks)) remoteLooks = parsed.looks
    } catch {
      remoteLooks = []
    }
  }
  const remoteById = new Map(remoteLooks.map((l) => [l.id, l]))
  const remotePhotos = await listRemotePhotoIds(token, owner, repo)

  const needPhoto: Look[] = []
  for (const look of looks) {
    const remote = remoteById.get(look.id)
    const hasPhoto = remotePhotos.has(look.id)
    if (!hasPhoto) {
      needPhoto.push(look)
      continue
    }
    // Re-upload if local full blob size differs from last recorded
    const localBlob = await getLookFullBlob(look.id)
    if (
      localBlob &&
      remote?.photoBytes != null &&
      localBlob.size !== remote.photoBytes
    ) {
      needPhoto.push(look)
    }
  }

  let photosUploaded = 0
  let photosSkipped = looks.length - needPhoto.length
  let bytesUploaded = 0
  const photoBytesById = new Map<string, number>()

  for (const [id, remote] of remoteById) {
    if (remote.photoBytes != null) photoBytesById.set(id, remote.photoBytes)
  }

  const totalPhotos = needPhoto.length
  onProgress?.({
    phase: 'photos',
    done: 0,
    total: totalPhotos,
    message:
      totalPhotos === 0
        ? 'фото уже на GitHub'
        : `фото 0 из ${totalPhotos}…`,
  })

  for (let i = 0; i < needPhoto.length; i++) {
    const look = needPhoto[i]
    onProgress?.({
      phase: 'photos',
      done: i,
      total: totalPhotos,
      message: `фото ${i + 1} из ${totalPhotos}…`,
    })

    let blob = await getLookFullBlob(look.id)
    if (!blob) {
      const row = await getLookPhoto(look.id)
      blob = row?.blob ?? row?.thumbBlob ?? null
    }
    if (!blob) {
      photosSkipped += 1
      continue
    }

    // Use stored main photo as-is (already compressed on device)
    const b64 = await blobToBase64(blob)
    const existing = remotePhotos.get(look.id)
    await putRepoFile(
      token,
      owner,
      repo,
      photoPath(look.id),
      b64,
      `look: photo ${look.id}`,
      existing?.sha,
    )
    photoBytesById.set(look.id, blob.size)
    bytesUploaded += blob.size
    photosUploaded += 1
    // Yield between uploads
    await new Promise((r) => setTimeout(r, 0))
  }

  onProgress?.({
    phase: 'meta',
    done: totalPhotos,
    total: Math.max(totalPhotos, 1),
    message: 'сохраняю список луков…',
  })

  const nextLooks: RemoteLookEntry[] = looks.map((look) => ({
    ...look,
    photoBytes: photoBytesById.get(look.id) ?? remoteById.get(look.id)?.photoBytes,
  }))
  const looksPayload: RemoteLooksPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    looks: nextLooks,
  }
  await putRepoTextFile(
    token,
    owner,
    repo,
    META_LOOKS_PATH,
    JSON.stringify(looksPayload, null, 2),
    'look: update meta/looks.json',
    remoteLooksFile?.sha,
  )

  const settingsFile = await getRepoFile(
    token,
    owner,
    repo,
    META_SETTINGS_PATH,
  )
  await putRepoTextFile(
    token,
    owner,
    repo,
    META_SETTINGS_PATH,
    JSON.stringify(settingsForBackup(settings), null, 2),
    'look: update meta/settings.json',
    settingsFile?.sha,
  )

  const next = await markBackupDone(await countLooks())
  await saveSettings({
    ...next,
    githubToken: settings.githubToken,
    githubRepoFullName: repoFullName,
    githubRepoTokenValidatedAt: Date.now(),
    backupSetupStep: 'ready',
    // New saves ignore legacy gist — clear so UI stops treating it as active
    githubGistId: undefined,
  })

  onProgress?.({
    phase: 'done',
    done: totalPhotos,
    total: Math.max(totalPhotos, 1),
    message: 'готово',
  })

  return {
    repoFullName,
    photosUploaded,
    photosSkipped,
    looksTotal: looks.length,
    bytesUploaded,
  }
}

export function githubSaveStatusMessage(result: GithubBackupResult): string {
  if (result.photosUploaded === 0) {
    return `сохранено · ${result.looksTotal} луков (фото уже были)`
  }
  return `сохранено · фото ${result.photosUploaded}, всего луков ${result.looksTotal}`
}

async function restoreFromRepo(
  token: string,
  repoFullName: string,
  onProgress?: (p: GithubBackupProgress) => void,
): Promise<{ imported: number; total: number }> {
  const { owner, repo } = parseRepoFullName(repoFullName)
  const looksFile = await getRepoFile(token, owner, repo, META_LOOKS_PATH)
  if (!looksFile?.text) {
    throw new Error('В репозитории нет списка луков — сначала сохрани копию')
  }
  let payload: RemoteLooksPayload
  try {
    payload = JSON.parse(looksFile.text) as RemoteLooksPayload
  } catch {
    throw new Error('Список луков на GitHub повреждён')
  }
  if (!Array.isArray(payload.looks)) {
    throw new Error('Неверный формат копии на GitHub')
  }

  const settingsFile = await getRepoFile(
    token,
    owner,
    repo,
    META_SETTINGS_PATH,
  )
  let remoteSettings: Settings | undefined
  if (settingsFile?.text) {
    try {
      remoteSettings = JSON.parse(settingsFile.text) as Settings
    } catch {
      remoteSettings = undefined
    }
  }

  const total = payload.looks.length
  let imported = 0
  const withPhotos: Array<Look & { photoBlob: Blob; thumbBlob?: Blob }> = []

  for (let i = 0; i < payload.looks.length; i++) {
    const entry = payload.looks[i]
    onProgress?.({
      phase: 'photos',
      done: i,
      total,
      message: `фото ${i + 1} из ${total}…`,
    })

    const { photoBytes: _photoBytes, ...rest } = entry
    const meta: Look = {
      ...rest,
      feedback: normalizeFeedback(entry.feedback),
      favorite: entry.favorite === true ? true : undefined,
    }

    const localPhoto = await getLookPhoto(meta.id)
    if (localPhoto?.blob) {
      await upsertLookMeta(meta)
      imported += 1
      await new Promise((r) => setTimeout(r, 0))
      continue
    }

    const blob = await downloadPhotoBlob(token, owner, repo, meta.id)
    if (!blob) {
      await upsertLookMeta(meta)
      imported += 1
      await new Promise((r) => setTimeout(r, 0))
      continue
    }

    try {
      const prepared = await prepareLookImages(blob)
      withPhotos.push({
        ...meta,
        photoBlob: prepared.blob,
        thumbBlob: prepared.thumbBlob,
      })
    } catch {
      withPhotos.push({ ...meta, photoBlob: blob, thumbBlob: blob })
    }
    imported += 1
    await new Promise((r) => setTimeout(r, 0))
  }

  if (withPhotos.length > 0) {
    await mergeLooks(withPhotos)
  }

  const current = await getSettings()
  if (remoteSettings) {
    const fromBackup = settingsForBackup(remoteSettings)
    await saveSettings({
      ...current,
      ...fromBackup,
      githubToken: current.githubToken,
      githubRepoFullName: repoFullName,
      githubRepoTokenValidatedAt:
        current.githubRepoTokenValidatedAt ?? Date.now(),
      backupSetupStep: 'ready',
      githubGistId: undefined,
      homePlace: fromBackup.homePlace ?? current.homePlace,
    })
  }

  onProgress?.({
    phase: 'done',
    done: total,
    total: Math.max(total, 1),
    message: 'готово',
  })

  return { imported, total: await countLooks() }
}

/** Legacy one-shot restore from private gist (old backups). */
async function restoreFromGist(
  token: string,
  gistId: string,
): Promise<{ imported: number; total: number }> {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: authHeaders(token),
  })
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        'Старая копия не найдена. Сохрани новую — в закрытый репозиторий.',
      )
    }
    throw new Error(`Не удалось прочитать старую копию (${res.status})`)
  }

  const data = (await res.json()) as GistResponse
  const file =
    data.files?.[GIST_FILENAME] ?? Object.values(data.files ?? {})[0]
  if (!file?.content) {
    throw new Error('В старой копии нет файла бэкапа')
  }

  let text = file.content
  if (file.truncated && file.raw_url) {
    const rawRes = await fetch(file.raw_url, {
      headers: { Authorization: `Bearer ${token.trim()}` },
    })
    if (!rawRes.ok) throw new Error('Не удалось скачать старую копию')
    text = await rawRes.text()
  }

  const payload = JSON.parse(text) as BackupPayload
  return importBackupPayload(payload)
}

export async function restoreBackupFromGithub(
  options: { onProgress?: (p: GithubBackupProgress) => void } = {},
): Promise<{ imported: number; total: number }> {
  const settings = await getSettings()
  const token = settings.githubToken?.trim()
  if (!token) {
    throw new Error('Сначала вставь ключ от GitHub')
  }

  const repoFullName = settings.githubRepoFullName?.trim()
  if (repoFullName) {
    return restoreFromRepo(token, repoFullName, options.onProgress)
  }

  const gistId = settings.githubGistId?.trim()
  if (gistId) {
    return restoreFromGist(token, gistId)
  }

  throw new Error('Пока нет сохранённой копии — сначала сохрани бэкап')
}

/** Rough plan for UI — how many looks / whether repo is known. */
export async function planGithubBackup(): Promise<{
  looksTotal: number
  label: string
  repoFullName?: string
}> {
  const [settings, looksTotal] = await Promise.all([
    getSettings(),
    countLooks(),
  ])
  const repo =
    settings.githubRepoFullName?.trim() ||
    (settings.githubToken
      ? `${DEFAULT_BACKUP_REPO} (создастся при сохранении)`
      : undefined)
  return {
    looksTotal,
    repoFullName: settings.githubRepoFullName,
    label:
      looksTotal === 0
        ? 'луков пока нет'
        : `в копии будет ${looksTotal} луков с фото${repo ? ` · ${repo}` : ''}`,
  }
}

export function formatUploadBytes(n: number): string {
  return formatBytes(n)
}
