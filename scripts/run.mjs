import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 某些环境（例如从 Electron 应用里派生的终端）会带上 ELECTRON_RUN_AS_NODE=1，
// 这会让 Electron 以纯 Node 模式启动，require('electron').app 变成 undefined。
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE

const cmd = process.argv[2] || 'dev'
const rest = process.argv.slice(3)
const bin = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

const child = spawn(process.execPath, [bin, cmd, ...rest], {
  stdio: 'inherit',
  env,
  cwd: root
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
