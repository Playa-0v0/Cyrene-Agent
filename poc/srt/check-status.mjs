// SRT Windows 沙箱 PoC - 第一步：查状态
// 只读检查，不触发 UAC、不改系统
// 用法: node poc/srt/check-status.mjs

const srt = await import('@anthropic-ai/sandbox-runtime')

console.log('=== SRT 可用导出 ===')
console.log(Object.keys(srt).sort().join('\n'))

console.log('\n=== Windows 沙箱状态 ===')
try {
  const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE })
  console.log('解析 srtWin:', JSON.stringify(srtWin))
  const status = await srt.checkWindowsSandboxStatusAsync({ srtWin })
  console.log(JSON.stringify(status, null, 2))
} catch (err) {
  console.error('查状态失败:', err.message)
  if (err.code) console.error('错误码:', err.code)
  console.error(err.stack)
}

console.log('\n=== srt-win.exe 路径 ===')
try {
  const p = srt.getSrtWinPath?.() || srt.resolveSrtWin?.() || '(未找到函数)'
  console.log(p)
} catch (err) {
  console.error('取路径失败:', err.message)
}
