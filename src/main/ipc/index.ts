import { app, ipcMain, shell, dialog, BrowserWindow } from 'electron'
import { loadSettings, saveSettings, applyProxy, userDataDir } from '../lib/settings'
import { search, readme, probeDocker, releases } from './github'
import { fetchQuota } from './quota'
import { polish, test as testAi, translate } from './ai'
import * as deploy from './deploy'
import * as clone from './clone'
import * as installer from './installer'
import * as leaderboard from './leaderboard'
import * as profile from '../lib/profile'
import { listDistros, diagnose } from '../lib/wslprobe'
import type { Settings, SearchParams, BoardQuery, ProfileInput } from '../../shared/types'
import type { EnvReport } from '../../shared/env'

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any | Promise<any>

/** 统一包装：成功返回 {ok:true,data}，失败返回 {ok:false,error,hint}，由 preload 解包成 Promise */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...args)
      return { ok: true, data }
    } catch (err: any) {
      console.error(`[ipc] ${channel} 失败:`, err)
      return {
        ok: false,
        error: String(err?.message || err),
        hint: String(err?.hint || '')
      }
    }
  })
}

export function registerIpc(): void {
  // ---------- app ----------
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    userData: userDataDir()
  }))

  handle('app:open-external', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接')
    await shell.openExternal(url)
  })

  handle('app:open-path', async (_e, p: string) => shell.openPath(p))

  // ---------- settings ----------
  handle('settings:get', () => loadSettings())

  handle('settings:save', async (_e, patch: Partial<Settings>) => {
    const next = saveSettings(patch)
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'proxy')) {
      await applyProxy(next.proxy)
    }
    return next
  })

  handle('settings:pick-dir', async (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) || undefined
    const res = await dialog.showOpenDialog(win as any, {
      title: title || '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })

  handle('settings:apply-proxy', async () => applyProxy())

  // ---------- ai ----------
  handle('ai:polish', async (_e, text: string) => polish(text))
  handle('ai:test', async () => testAi())
  handle('ai:translate', async (_e, input: { text: string; fullName?: string }) => translate(input))

  // ---------- github ----------
  handle('github:search', async (_e, params: SearchParams) => search(params))
  handle('github:readme', async (_e, owner: string, repo: string, branch?: string) =>
    readme(owner, repo, branch)
  )
  handle('github:probe-docker', async (_e, owner: string, repo: string) =>
    probeDocker(owner, repo)
  )
  handle('github:releases', async (_e, owner: string, repo: string) =>
    releases(owner, repo)
  )
  handle('github:quota', async () => fetchQuota())

  // ---------- deploy ----------
  handle('deploy:plan', async (_e, input: any) => deploy.plan(input))
  handle('deploy:run', async (event, plan: any) => {
    const taskId = deploy.run(plan, event.sender)
    return { taskId }
  })
  handle('deploy:stop', async (_e, taskId: string, distro: string) => {
    deploy.stop(taskId, distro)
  })
  handle('deploy:wsl-distros', async () => listDistros())
  handle('deploy:containers', async (_e, distro?: string) => deploy.containers(distro))

  // ---------- clone（拉取到指定目录） ----------
  handle('clone:plan', async (_e, input: any) => clone.plan(input))
  handle('clone:run', async (event, plan: any) => ({ taskId: clone.run(plan, event.sender) }))
  handle('clone:cancel', async (_e, taskId: string) => clone.cancel(taskId))
  handle('clone:reveal', async (_e, plan: any) => clone.reveal(plan))
  handle('clone:check-git', async () => clone.checkGit())
  handle('clone:defaults', async () => clone.defaults())

  // ---------- env ----------
  handle('env:diagnose', async (_e, opts?: { useAi?: boolean }): Promise<EnvReport> =>
    diagnose({ useAi: opts?.useAi })
  )

  // ---------- install ----------
  handle('install:download', async (event, input: any) => installer.startDownload(input, event.sender))
  handle('install:cancel', async (_e, taskId: string) => installer.cancel(taskId))

  // ---------- board ----------
  handle('board:fetch', async (_e, query: BoardQuery) => leaderboard.fetchBoard(query))
  handle('board:tracked', async () => leaderboard.trackedList())
  handle('board:toggle-track', async (_e, fullName: string, stars?: number) =>
    leaderboard.toggleTrack(fullName, stars)
  )
  handle('board:clear-cache', async () => leaderboard.clearCache())
  handle('board:enrich', async (event, input: { items: ProfileInput[]; scope?: string; force?: boolean }) =>
    profile.enrich(input?.items || [], event.sender, {
      scope: input?.scope,
      force: input?.force
    })
  )
  handle('board:clear-profiles', async () => profile.clearProfiles())
}
