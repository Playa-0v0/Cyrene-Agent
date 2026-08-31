// SRT Windows 沙箱 PoC - 第二步：安装（触发 UAC）
// 一次性安装：建 srt-sandbox 本地用户 + 装 WFP 过滤器（一次 UAC）
// 幂等：重跑会轮换 sandbox 用户密码，不会重复装
// 用法: node poc/srt/install.mjs
//
// 这一步会弹 UAC，点"是"才会装；点"否"不报错，返回 cancelled: true

const srt = await import('@anthropic-ai/sandbox-runtime')

// 1. 解析 srt-win.exe 路径（用包里自带的）
const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE })
console.log('srt-win.exe:', srtWin.exe)
console.log('prependArgs:', srtWin.prependArgs)

// 2. 装前状态（只读，不弹 UAC）
console.log('\n=== 装前状态 ===')
const before = await srt.checkWindowsSandboxStatusAsync({ srtWin })
console.log('user.provisioned:', before.user.provisioned)
console.log('wfp.state:', before.wfp.state)

// 3. 触发安装（这里会弹 UAC）
console.log('\n=== 触发安装（请看 UAC 弹窗）===')
const result = await srt.installWindowsSandboxAsync({ srtWin })

if (result.cancelled) {
  console.log('\n[取消] 用户没点 UAC，安装没发生。准备好再重跑。')
  process.exit(0)
}

console.log('\n=== 安装结果 ===')
console.log('user.provisioned:', result.user.provisioned)
console.log('user.sid:', result.user.sid)
console.log('wfp.state:', result.wfp.state)
console.log('wfp.filters:', result.wfp.filters)
console.log('wfp.portRange:', result.wfp.portRange)

// 4. 装后状态复核
console.log('\n=== 装后状态复核 ===')
const after = await srt.checkWindowsSandboxStatusAsync({ srtWin })
console.log('user.provisioned:', after.user.provisioned)
console.log('user.sid:', after.user.sid)
console.log('wfp.state:', after.wfp.state)

console.log('\n[完成] 安装成功。下一步跑 run-cmd.mjs 验证沙箱内执行。')
