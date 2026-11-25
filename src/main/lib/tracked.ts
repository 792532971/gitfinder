/** 关注列表（用于「我的追踪榜」），存 userData/tracked.json */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const MAX_TRACKED = 60
let cache: string[] | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'tracked.json')
}

function valid(name: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(name)
}

export function list(): string[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8'))
    cache = Array.isArray(raw) ? raw.filter((x: any) => typeof x === 'string' && valid(x)) : []
  } catch {
    cache = []
  }
  return cache!
}

function save(next: string[]): void {
  cache = next
  try {
    const dir = path.dirname(file())
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.error('[tracked] 写入失败', err)
  }
}

export function has(fullName: string): boolean {
  return list().includes(fullName)
}

/** 加/取消关注，返回最新列表 */
export function toggle(fullName: string): string[] {
  const name = String(fullName || '').trim()
  if (!valid(name)) throw new Error('仓库名格式应为 owner/repo')
  const cur = list()
  if (cur.includes(name)) {
    const next = cur.filter((n) => n !== name)
    save(next)
    return next
  }
  if (cur.length >= MAX_TRACKED) {
    throw new Error(`最多追踪 ${MAX_TRACKED} 个仓库，先取消几个再试`)
  }
  const next = [name, ...cur]
  save(next)
  return next
}

export function remove(fullName: string): string[] {
  const next = list().filter((n) => n !== fullName)
  save(next)
  return next
}
