import { describe, expect, it } from 'vitest'
import {
  isGithubAccessError,
  needsNewGithubKey,
} from './githubBackup'

describe('needsNewGithubKey', () => {
  it('is false when token was repo-validated', () => {
    expect(
      needsNewGithubKey({
        githubToken: 'ghp_x',
        githubGistId: 'old',
        githubRepoTokenValidatedAt: Date.now(),
      }),
    ).toBe(false)
  })

  it('detects legacy gist without repo validation', () => {
    expect(
      needsNewGithubKey({
        githubToken: 'ghp_x',
        githubGistId: 'abc123',
      }),
    ).toBe(true)
  })

  it('detects token without private repo evidence', () => {
    expect(
      needsNewGithubKey({
        githubToken: 'ghp_x',
      }),
    ).toBe(true)
  })

  it('respects explicit need-new-key step', () => {
    expect(
      needsNewGithubKey({
        githubToken: 'ghp_x',
        githubRepoFullName: 'u/look-weather-data',
        backupSetupStep: 'need-new-key',
      }),
    ).toBe(true)
  })

  it('allows pre-marker repo users with repo name and no gist', () => {
    expect(
      needsNewGithubKey({
        githubToken: 'ghp_x',
        githubRepoFullName: 'u/look-weather-data',
      }),
    ).toBe(false)
  })
})

describe('isGithubAccessError', () => {
  it('matches auth status codes', () => {
    expect(isGithubAccessError('fail (401)')).toBe(true)
    expect(isGithubAccessError('Не удалось сохранить photos/x.jpg (403)')).toBe(
      true,
    )
    expect(isGithubAccessError('not found 404')).toBe(true)
  })

  it('matches Russian scope hints', () => {
    expect(
      isGithubAccessError(
        'В ключе нужна галочка repo (доступ к закрытым репозиториям). Создай новый ключ и вставь сюда.',
      ),
    ).toBe(true)
    expect(isGithubAccessError('Ключ не подошёл')).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isGithubAccessError('Сеть недоступна')).toBe(false)
  })
})
