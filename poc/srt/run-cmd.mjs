// SRT Windows 沙箱 PoC - 第三步：沙箱内执行命令
// 用 SandboxManager.wrapWithSandboxArgv 包命令，自己 spawn 执行
// 关键：spawn 必须 { shell: false }——这是安全边界
// 用法: node poc/srt/run-cmd.mjs

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const srt = await import('@anthropic-ai/sandbox-runtime')

// 给沙箱用户一个可写临时目录（它默认对真实用户文件无权限）
// 必须先建好目录，initialize 才能给沙箱用户 grant ACL
const tmpDir = path.join(os.tmpdir(), 'srt-poc-' + Date.now())
mkdirSync(tmpDir, { recursive: true })

const config = {
  network: {
    allowedDomains: [],   // 全拦——PoC 不需要联网
    deniedDomains: [],
  },
  filesystem: {
    denyRead: [],
    allowWrite: [tmpDir], // 只允许写这个临时目录
    denyWrite: [],
  },
  windows: {
    srtWin: { path: srt.VENDORED_SRT_WIN_EXE },
  },
}

console.log('=== 初始化 SandboxManager ===')
console.log('临时可写目录:', tmpDir)
await srt.SandboxManager.initialize(config)
console.log('[初始化完成]')

// 跑一条命令的封装
async function runInSandbox(label, command) {
  console.log(`\n=== ${label}: ${command} ===`)
  const { argv, env } = await srt.SandboxManager.wrapWithSandboxArgv(
    command, undefined, undefined, undefined, tmpDir
  )
  console.log('argv[0]:', argv[0])
  console.log('argv.length:', argv.length)
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      env,
      cwd: tmpDir,
      stdio: 'inherit',
    })
    child.on('close', (code) => {
      console.log(`[退出码] ${code}`)
      resolve(code)
    })
    child.on('error', (err) => {
      console.error('[spawn 错误]', err.message)
      resolve(-1)
    })
  })
}

try {
  // 1. whoami：应输出 srt-sandbox（证明跑在沙箱用户下）
  await runInSandbox('身份验证', 'whoami')

  // 2. pip --version：原 handoff 目标命令
  await runInSandbox('pip 版本', 'pip --version')
} catch (err) {
  console.error('\n[错误]', err.message)
  if (err.code) console.error('错误码:', err.code)
  console.error(err.stack)
} finally {
  await srt.SandboxManager.reset()
  console.log('\n[完成] SandboxManager 已重置。')
}
