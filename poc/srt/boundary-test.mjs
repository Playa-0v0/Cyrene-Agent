// SRT Windows 沙箱 PoC - 第四步：越界测试（文件系统隔离）
// 两条对照：
//   A. 写 C:\Windows\test.txt —— 应被拒（沙箱用户无权写 Windows 目录）
//   B. 写 tmpDir\ok.txt —— 应成功（allowWrite 授权了）
// 用法: node poc/srt/boundary-test.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const srt = await import('@anthropic-ai/sandbox-runtime')

const tmpDir = path.join(os.tmpdir(), 'srt-poc-boundary-' + Date.now())
mkdirSync(tmpDir, { recursive: true })

const config = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: [],
    allowWrite: [tmpDir],     // 只允许写 tmpDir
    denyWrite: [],
  },
  windows: {
    srtWin: { path: srt.VENDORED_SRT_WIN_EXE },
  },
}

console.log('=== 越界测试 ===')
console.log('可写目录:', tmpDir)
await srt.SandboxManager.initialize(config)

async function runInSandbox(label, command) {
  console.log(`\n--- ${label} ---`)
  console.log('命令:', command)
  const { argv, env } = await srt.SandboxManager.wrapWithSandboxArgv(
    command, undefined, undefined, undefined, tmpDir
  )
  let stdout = '', stderr = ''
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false, env, cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => stdout += d.toString())
    child.stderr.on('data', (d) => stderr += d.toString())
    child.on('close', (code) => {
      if (stdout.trim()) console.log('stdout:', stdout.trim())
      if (stderr.trim()) console.log('stderr:', stderr.trim())
      console.log('退出码:', code)
      resolve(code)
    })
    child.on('error', (err) => {
      console.log('spawn 错误:', err.message)
      resolve(-1)
    })
  })
}

try {
  // A. 越界写 C:\Windows\test.txt —— 期望被拒（退出码非 0）
  const forbidden = 'C:\\Windows\\srt-poc-test.txt'
  console.log('\n[A] 越界写（应被拒）:', forbidden)
  const codeA = await runInSandbox('越界写', `echo srt-poc > "${forbidden}"`)
  console.log('文件是否存在:', existsSync(forbidden) ? '是（危险！隔离失败）' : '否（隔离生效）')

  // B. 合法写 tmpDir\ok.txt —— 期望成功（退出码 0）
  const allowed = path.join(tmpDir, 'ok.txt')
  console.log('\n[B] 合法写（应成功）:', allowed)
  const codeB = await runInSandbox('合法写', `echo hello-from-sandbox > "${allowed}"`)
  if (existsSync(allowed)) {
    console.log('文件内容:', readFileSync(allowed, 'utf8').trim())
    console.log('合法写成功 ✓')
  } else {
    console.log('文件不存在（合法写也失败了，配置有问题）')
  }

  // 汇总
  console.log('\n=== 汇总 ===')
  console.log('越界写退出码:', codeA, codeA !== 0 ? '→ 被拒 ✓' : '→ 通过（隔离失效！）')
  console.log('合法写退出码:', codeB, codeB === 0 ? '→ 成功 ✓' : '→ 失败')
} catch (err) {
  console.error('\n[错误]', err.message)
  if (err.code) console.error('错误码:', err.code)
  console.error(err.stack)
} finally {
  await srt.SandboxManager.reset()
  // 清理临时目录
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  console.log('\n[完成] 已重置并清理。')
}
