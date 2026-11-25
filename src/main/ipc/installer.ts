import { app, shell, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { runWindowsExe, ensureWindowsDir } from '../lib/shell'

interface DownloadJob {
  controller: AbortController
  target: string
}

const jobs = new Map<string, DownloadJob>()

function safeFileName(name: string): string {
  const base = path.basename(String(name || 'setup.exe'))
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  return cleaned || 'setup.exe'
}

export function downloadDir(): string {
  const dir = path.join(app.getPath('temp'), 'gitfinder-downloads')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function detectInstallerKind(file: string): 'nsis' | 'msi' | 'squirrel' | 'unknown' {
  if (/\.msi$/i.test(file)) return 'msi'
  try {
    // 读文件头判断 PE 里的字符串特征，粗略区分 NSIS / Squirrel
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(2 * 1024 * 1024, fs.statSync(file).size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const head = buf.toString('latin1')
    if (head.includes('Nullsoft') || head.includes('NSIS')) return 'nsis'
    if (head.includes('Squirrel') || head.includes('Update.exe')) return 'squirrel'
  } catch {
    /* ignore */
  }
  return 'unknown'
}

export async function startDownload(
  input: { url: string; fileName: string; mode: 'silent' | 'manual'; installDir: string },
  sender: WebContents
): Promise<{ taskId: string }> {
  const taskId = randomUUID()
  const fileName = safeFileName(input.fileName)
  const target = path.join(downloadDir(), fileName)
  const controller = new AbortController()
  jobs.set(taskId, { controller, target })

  const emitProgress = (
    received: number,
    total: number,
    phase: 'download' | 'install' | 'done'
  ): void => {
    if (sender.isDestroyed()) return
    sender.send('install:progress', {
      taskId,
      received,
      total,
      percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
      phase
    })
  }
  const emitDone = (ok: boolean, message: string, filePath?: string): void => {
    if (sender.isDestroyed()) return
    sender.send('install:done', { taskId, ok, message, filePath })
  }

  ;(async () => {
    try {
      if (!/^https:\/\//i.test(input.url)) throw new Error('下载地址必须是 https')
      const res = await net.fetch(input.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { Accept: 'application/octet-stream' }
      })
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

      const total = Number(res.headers.get('content-length') || 0)
      const body = res.body
      if (!body) throw new Error('响应体为空')

      const out = fs.createWriteStream(target)
      const reader = body.getReader()
      let received = 0
      let lastTick = 0

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        received += value.byteLength
        // 等待写入回调，天然形成背压，避免大文件把内存吃满
        await new Promise<void>((resolve, reject) => {
          out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
        })
        const now = Date.now()
        if (now - lastTick > 120) {
          lastTick = now
          emitProgress(received, total, 'download')
        }
        if (controller.signal.aborted) {
          reader.cancel().catch(() => undefined)
          throw new Error('已取消下载')
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
      emitProgress(received, total || received, 'download')

      const stat = fs.statSync(target)
      if (stat.size < 1024) throw new Error('下载的文件异常（小于 1KB），可能不是有效的安装包')

      emitProgress(received, total || received, 'install')

      if (input.mode === 'manual') {
        await shell.openPath(target)
        emitDone(
          true,
          `已下载并打开安装程序，请按安装向导操作。文件位置：${target}`,
          target
        )
        jobs.delete(taskId)
        return
      }

      // 静默安装
      const kind = detectInstallerKind(target)
      const dir = (input.installDir || '').trim()
      if (kind === 'nsis' || kind === 'unknown' || kind === 'squirrel') {
        if (!dir) throw new Error('静默安装需要先选择安装目录')
        const canWrite = await ensureWindowsDir(dir)
        if (!canWrite) throw new Error(`无法创建或写入目录：${dir}`)
        // NSIS: /S 静默，/D= 指定目录且必须是最后一个参数、不能加引号
        const args = ['/S', `/D=${dir}`]
        const r = await runWindowsExe(target, args)
        if (!r.ok) {
          emitDone(
            false,
            `${r.message}\n这类安装包可能不支持静默安装，建议切换到"手动安装"模式`,
            target
          )
          jobs.delete(taskId)
          return
        }
        await new Promise((res2) => setTimeout(res2, 1200))
        let installed = false
        try {
          installed = fs.existsSync(dir) && fs.readdirSync(dir).length > 0
        } catch {
          installed = false
        }
        emitProgress(received, total || received, 'done')
        emitDone(
          true,
          installed
            ? `安装完成，目录：${dir}`
            : `安装程序已执行，但目标目录为空。该安装包可能不支持 /D 参数，建议改用手动安装并手动选择目录。`,
          target
        )
      } else if (kind === 'msi') {
        if (!dir) throw new Error('静默安装需要先选择安装目录')
        await ensureWindowsDir(dir)
        const r = await runWindowsExe('msiexec.exe', [
          '/i',
          target,
          '/qb',
          `/l*v`,
          path.join(downloadDir(), 'msi-install.log'),
          `INSTALLDIR=${dir}`
        ])
        emitProgress(received, total || received, 'done')
        emitDone(r.ok, r.ok ? `安装完成，目录：${dir}` : r.message, target)
      } else {
        emitDone(true, `已下载：${target}，请手动运行安装`, target)
      }
      jobs.delete(taskId)
    } catch (err: any) {
      const msg = controller.signal.aborted ? '已取消' : String(err?.message || err)
      emitDone(false, msg)
      jobs.delete(taskId)
      try {
        if (fs.existsSync(target) && controller.signal.aborted) fs.unlinkSync(target)
      } catch {
        /* ignore */
      }
    }
  })()

  return { taskId }
}

export function cancel(taskId: string): void {
  const job = jobs.get(taskId)
  if (!job) return
  job.controller.abort()
  jobs.delete(taskId)
}
