import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface LineHandlers {
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onError?: (err: Error) => void
}

/** 把二进制输出解码成文本：自动识别 UTF-16LE（wsl.exe -l 的输出）和 UTF-8 */
export function decodeWslBuffer(buf: Buffer): string {
  if (buf.length >= 4) {
    let zeroOdd = 0
    let zeroEven = 0
    const limit = Math.min(buf.length, 512)
    for (let i = 0; i < limit; i++) {
      if (buf[i] === 0) {
        if (i % 2 === 0) zeroEven++
        else zeroOdd++
      }
    }
    if (zeroOdd > limit / 4 && zeroOdd > zeroEven * 3) {
      return buf.toString('utf16le')
    }
    if (zeroEven > limit / 4 && zeroEven > zeroOdd * 3) {
      // UTF-16BE 极少见，按 UTF-16LE 反序处理
      const swapped = Buffer.from(buf)
      swapped.swap16()
      return swapped.toString('utf16le')
    }
  }
  return buf.toString('utf8')
}

/** 逐行切分器，处理跨 chunk 的半个多字节字符 */
class LineSplitter {
  private decoder = new StringDecoder('utf8')
  private rest = ''
  private emit: (line: string) => void
  constructor(emit: (line: string) => void) {
    this.emit = emit
  }
  push(chunk: Buffer): void {
    this.rest += this.decoder.write(chunk)
    const parts = this.rest.split(/\r?\n/)
    this.rest = parts.pop() || ''
    for (const p of parts) {
      if (p.length) this.emit(p)
    }
  }
  flush(): void {
    this.rest += this.decoder.end()
    if (this.rest.trim().length) {
      this.emit(this.rest)
      this.rest = ''
    }
  }
}

/**
 * 在 WSL 里执行一段 bash 脚本。
 * 脚本用 base64 传输，彻底避免 Windows → WSL 的引号/反斜杠转义问题。
 */
export function runWslScript(
  script: string,
  opts: { distro?: string; cwd?: string } & LineHandlers
): ChildProcess {
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  const quoted = `echo '${b64}' | base64 -d | bash -s`
  const args: string[] = []
  if (opts.distro) args.push('-d', opts.distro)
  if (opts.cwd) args.push('--cd', opts.cwd)
  args.push('--', 'bash', '-lc', quoted)

  const child = spawn('wsl.exe', args, {
    env: { ...process.env, WSL_UTF8: '1' },
    windowsHide: true
  })

  const outSplit = new LineSplitter((l) => opts.onStdout?.(l))
  const errSplit = new LineSplitter((l) => opts.onStderr?.(l))

  child.stdout?.on('data', (c: Buffer) => outSplit.push(c))
  child.stderr?.on('data', (c: Buffer) => errSplit.push(c))
  child.on('error', (err) => opts.onError?.(err))
  child.on('close', (code, signal) => {
    outSplit.flush()
    errSplit.flush()
    opts.onExit?.(code, signal)
  })
  return child
}

/** 一次性执行 WSL 命令并拿到完整输出（用于列发行版、查容器） */
export function execWslCapture(
  script: string,
  opts: { distro?: string; timeoutMs?: number } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf8').toString('base64')
    const args: string[] = []
    if (opts.distro) args.push('-d', opts.distro)
    args.push('--', 'bash', '-lc', `echo '${b64}' | base64 -d | bash -s`)

    const child = spawn('wsl.exe', args, {
      env: { ...process.env, WSL_UTF8: '1' },
      windowsHide: true
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve({ code: -1, stdout: out, stderr: err + '\n执行超时' })
    }, opts.timeoutMs ?? 25000)

    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: out, stderr: String(e?.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: out, stderr: err })
    })
  })
}

/**
 * 执行 Windows 程序（用于运行安装包）。
 * detached=true 时脱离父进程，关掉 GitFinder 也不会杀掉安装器。
 */
export function runWindowsExe(
  file: string,
  args: string[] = [],
  opts: { detached?: boolean; cwd?: string } = {}
): Promise<{ ok: boolean; message: string; pid?: number }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, {
        cwd: opts.cwd,
        detached: !!opts.detached,
        stdio: opts.detached ? 'ignore' : 'pipe',
        windowsHide: false
      })
      child.on('error', (err) => resolve({ ok: false, message: String(err?.message || err) }))
      if (opts.detached) {
        child.unref()
        resolve({ ok: true, message: '安装程序已启动', pid: child.pid })
      } else {
        child.on('close', (code) =>
          resolve({
            ok: code === 0,
            message: code === 0 ? '安装程序执行完成' : `安装程序退出码 ${code}`,
            pid: child.pid
          })
        )
      }
    } catch (err: any) {
      resolve({ ok: false, message: String(err?.message || err) })
    }
  })
}

/** 用 PowerShell 查某个路径是否可写、目录是否存在 */
export async function ensureWindowsDir(dir: string): Promise<boolean> {
  const { default: fs } = await import('node:fs')
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}
