import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  DeployLogEvent,
  DeployDoneEvent,
  CloneLogEvent,
  CloneDoneEvent,
  InstallProgressEvent,
  InstallDoneEvent,
  ProfileUpdateEvent
} from '../shared/types'

async function call<T>(channel: string, ...args: any[]): Promise<T> {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res || res.ok !== true) {
    // 注意：跨 contextBridge 抛出的 Error 会丢掉自定义属性，所以把 hint 直接拼进 message
    const msg = res?.error || '未知错误'
    const hint = res?.hint || ''
    throw new Error(hint ? `${msg}\n${hint}` : msg)
  }
  return res.data as T
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  app: {
    info: () => call('app:info'),
    openExternal: (url) => call('app:open-external', url),
    openPath: (p) => call('app:open-path', p)
  },
  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
    pickDir: (title) => call('settings:pick-dir', title),
    applyProxy: () => call('settings:apply-proxy')
  },
  ai: {
    polish: (text) => call('ai:polish', text),
    translate: (input) => call('ai:translate', input),
    test: () => call('ai:test')
  },
  github: {
    search: (params) => call('github:search', params),
    readme: (owner, repo, branch) => call('github:readme', owner, repo, branch),
    probeDocker: (owner, repo) => call('github:probe-docker', owner, repo),
    releases: (owner, repo) => call('github:releases', owner, repo),
    quota: () => call('github:quota')
  },
  deploy: {
    plan: (input) => call('deploy:plan', input),
    run: (plan) => call('deploy:run', plan),
    stop: (taskId, distro) => call('deploy:stop', taskId, distro ?? ''),
    wslDistros: () => call('deploy:wsl-distros'),
    containers: (distro?: string) => call('deploy:containers', distro)
  },
  install: {
    download: (input) => call('install:download', input),
    cancel: (taskId) => call('install:cancel', taskId)
  },
  clone: {
    plan: (input) => call('clone:plan', input),
    run: (plan) => call('clone:run', plan),
    cancel: (taskId) => call('clone:cancel', taskId),
    reveal: (plan) => call('clone:reveal', plan),
    checkGit: () => call('clone:check-git'),
    defaults: () => call('clone:defaults')
  },
  env: {
    diagnose: (opts) => call('env:diagnose', opts)
  },
  board: {
    fetch: (query) => call('board:fetch', query),
    tracked: () => call('board:tracked'),
    toggleTrack: (fullName, stars) => call('board:toggle-track', fullName, stars),
    clearCache: () => call('board:clear-cache'),
    enrich: (input) => call('board:enrich', input),
    clearProfiles: () => call('board:clear-profiles')
  },
  events: {
    onDeployLog: (cb) => subscribe<DeployLogEvent>('deploy:log', cb),
    onDeployDone: (cb) => subscribe<DeployDoneEvent>('deploy:done', cb),
    onCloneLog: (cb) => subscribe<CloneLogEvent>('clone:log', cb),
    onCloneDone: (cb) => subscribe<CloneDoneEvent>('clone:done', cb),
    onInstallProgress: (cb) => subscribe<InstallProgressEvent>('install:progress', cb),
    onInstallDone: (cb) => subscribe<InstallDoneEvent>('install:done', cb),
    onBoardProfiles: (cb) => subscribe<ProfileUpdateEvent>('board:profiles', cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
