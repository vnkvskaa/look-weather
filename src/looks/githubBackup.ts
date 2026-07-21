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
const META_LOOKS_PATH = 'meta/looks.json'
const META_SETTINGS_PATH = 'meta/settings.json'
const GIST_FILENAME = 'look-weather-backup.json'

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
}

/** Lightweight PAT check — GET /user. Throws with plain Russian errors. */
export async function validateGithubToken(
  token: string,
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
  return { login: data.login }
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
      throw new Error(
        'Нет доступа к репозиторию. В ключе нужна галочка repo (или Contents на этот репозиторий).',
      )
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
      throw new Error(
        'Не удалось создать папку на GitHub. В ключе нужна галочка repo.',
      )
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
      throw new Error(
        'Ключ не даёт писать в репозиторий. Нужна галочка repo.',
      )
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
 * Confirm token works and backup repo (or legacy gist) is reachable.
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
  const { login } = await validateGithubToken(token)
  let hasCopy = false
  let repoFullName = settings.githubRepoFullName?.trim()

  if (repoFullName) {
    const { owner, repo } = parseRepoFullName(repoFullName)
    const res = await apiJson<ContentFile>(
      `https://api.github.com/repos/${owner}/${repo}/contents/${META_LOOKS_PATH}`,
      token,
    )
    if (res.status === 404) {
      throw new Error(
        'Папка на GitHub есть, но копии ещё нет. Нажми «сохранить сейчас».',
      )
    }
    if (!res.ok) {
      throw new Error(`Не удалось проверить копию (${res.status})`)
    }
    hasCopy = true
  } else if (settings.githubGistId?.trim()) {
    const gistId = settings.githubGistId.trim()
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: authHeaders(token),
    })
    if (res.status === 404) {
      throw new Error(
        'Старая копия (gist) не найдена. Сохрани заново — появится закрытый репозиторий.',
      )
    }
    if (!res.ok) {
      throw new Error(`Не удалось проверить старую копию (${res.status})`)
    }
    hasCopy = true
  }

  await saveSettings({
    ...settings,
    githubBackupVerifiedAt: Date.now(),
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

  const { login } = await validateGithubToken(token)
  const repoName =
    options.repoName?.trim() ||
    settings.githubRepoFullName?.split('/')[1] ||
    DEFAULT_BACKUP_REPO
  const repoFullName = await ensurePrivateRepo(token, login, repoName)
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
    // keep legacy gist id for one-shot restore
    githubGistId: settings.githubGistId,
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
      githubGistId: current.githubGistId,
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
