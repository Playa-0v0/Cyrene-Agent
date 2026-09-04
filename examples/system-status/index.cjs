"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

/** 插件自己的状态窗口实例；open() 时创建，unregister() 时关闭 */
let pluginWin = null;

/** nvidia-smi 是否可用（失败一次后不再重试） */
let nvidiaSmiAvailable = true;

/** CPU 差分采样的上一次快照 */
let lastCpuSample = null;

/** 网络累计字节数的上一次快照（用于差分算速率） */
let lastNetSample = null;

/** @returns {Promise<{ok: boolean, stdout?: string, stderr?: string}>} */
function runCommand(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// ---------------------------------------------------------------------------
// CPU：os.cpus() 两次采样差分，纯进程内计算，零开销
// ---------------------------------------------------------------------------
function sampleCpuPercent() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  let percent = null;
  if (lastCpuSample) {
    const dIdle = idle - lastCpuSample.idle;
    const dTotal = total - lastCpuSample.total;
    if (dTotal > 0) percent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  lastCpuSample = { idle, total };
  return percent;
}

// ---------------------------------------------------------------------------
// GPU：优先 nvidia-smi（温度/占用/显存一把抓）；不可用时回退 WMI 性能计数器
// ---------------------------------------------------------------------------
async function readGpu() {
  if (nvidiaSmiAvailable) {
    const r = await runCommand("nvidia-smi", [
      "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ], 3000);
    const parts = r.ok ? r.stdout.trim().split(/\s*,\s*/) : [];
    const nums = parts.map(Number);
    if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
      const [temp, util, vramUsed, vramTotal] = nums;
      return {
        percent: util,
        temperature: temp,
        vramUsedMb: vramUsed,
        vramTotalMb: vramTotal,
      };
    }
    nvidiaSmiAvailable = false; // 没装 N 卡驱动，以后不再尝试
  }
  return { percent: null, temperature: null, vramUsedMb: null, vramTotalMb: null };
}

// ---------------------------------------------------------------------------
// 磁盘 + 网络 + 电池 + GPU 引擎回退：一次 PowerShell 调用全部拿完
// ---------------------------------------------------------------------------
async function readWindowsMisc() {
  const script = [
    "$r = [ordered]@{}",
    "$r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace)",
    "$net = Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Measure-Object -Property ReceivedBytes,SentBytes -Sum",
    "$r.net = @{ r = [double]$net.ReceivedBytes; s = [double]$net.SentBytes }",
    "$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue",
    "if ($bat) { $r.bat = @{ p = [int]$bat.EstimatedChargeRemaining; charging = ($bat.BatteryStatus -eq 2) } } else { $r.bat = $null }",
    "$g = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Measure-Object -Property UtilizationPercentage -Sum",
    "if ($g.Sum -ne $null) { $r.gpuEngine = [math]::Round([double]$g.Sum, 1) } else { $r.gpuEngine = $null }",
    "ConvertTo-Json -InputObject $r -Compress -Depth 4",
  ].join("; ");
  const r = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 8000);
  if (!r.ok || !r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 网络速率：累计字节差分
// ---------------------------------------------------------------------------
function netBytesPerSecond(net) {
  if (!net || !Number.isFinite(net.r) || !Number.isFinite(net.s)) return null;
  const now = Date.now();
  const total = net.r + net.s;
  if (!lastNetSample) {
    lastNetSample = { total, time: now };
    return null; // 第一次采样没有差分基准
  }
  const dBytes = total - lastNetSample.total;
  const dSeconds = (now - lastNetSample.time) / 1000;
  lastNetSample = { total, time: now };
  if (dSeconds <= 0 || dBytes < 0) return null;
  return dBytes / dSeconds;
}

function formatBytes(bytes) {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `已运行 ${d} 天 ${h % 24} 小时`;
  }
  const m = Math.floor((seconds % 3600) / 60);
  return `已运行 ${h} 小时 ${m} 分钟`;
}

function mbToGb(mb) {
  return Math.round((mb / 1024) * 10) / 10;
}

// ---------------------------------------------------------------------------
// 完整快照：供弹窗 UI 消费（字段结构与 ui.html 约定一致）
// ---------------------------------------------------------------------------
async function collectSnapshot() {
  const cpuPercent = sampleCpuPercent();
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const cpuInfo = os.cpus()[0];

  const [gpu, misc] = await Promise.all([readGpu(), readWindowsMisc()]);

  const snapshot = {
    cpuPercent: cpuPercent == null ? null : Math.round(cpuPercent),
    gpuPercent: null,
    memoryPercent: Math.round((usedMem / totalMem) * 100),
    memoryUsedGb: Math.round((usedMem / 1024 ** 3) * 10) / 10,
    memoryTotalGb: Math.round((totalMem / 1024 ** 3) * 10) / 10,
    disks: [],
    gpuTemperature: gpu.temperature,
    vramUsedGb: gpu.vramUsedMb == null ? null : mbToGb(gpu.vramUsedMb),
    vramTotalGb: gpu.vramTotalMb == null ? null : mbToGb(gpu.vramTotalMb),
    networkBytesPerSecond: null,
    batteryPercent: null,
    batteryLabel: "台式机",
    uptime: formatUptime(os.uptime()),
    cpuModel: cpuInfo ? `${cpuInfo.model.trim()} · ${os.cpus().length} 核` : null,
  };

  // GPU 占用：nvidia-smi 优先，WMI 引擎计数器兜底
  if (gpu.percent != null) snapshot.gpuPercent = Math.round(gpu.percent);
  else if (misc && Number.isFinite(misc.gpuEngine)) snapshot.gpuPercent = Math.round(Math.min(100, misc.gpuEngine));

  if (misc) {
    if (Array.isArray(misc.disks)) {
      snapshot.disks = misc.disks
        .filter((d) => Number.isFinite(d.Size) && d.Size > 0)
        .map((d) => {
          const used = d.Size - d.FreeSpace;
          return {
            name: d.DeviceID || "?",
            usedGb: Math.round((used / 1024 ** 3) * 10) / 10,
            totalGb: Math.round((d.Size / 1024 ** 3) * 10) / 10,
            percent: Math.round((used / d.Size) * 100),
          };
        })
        .slice(0, 6);
    }
    snapshot.networkBytesPerSecond = netBytesPerSecond(misc.net);
    if (misc.bat && Number.isFinite(misc.bat.p)) {
      snapshot.batteryPercent = misc.bat.p;
      snapshot.batteryLabel = misc.bat.charging ? "充电中" : "使用电池";
    }
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// 文本版状态（给 AI 工具用的简洁输出）
// ---------------------------------------------------------------------------
async function collectStatus() {
  const snapshot = await collectSnapshot();
  const lines = [];
  lines.push(`系统: ${os.type()} ${os.release()} (${os.arch()})`);
  lines.push(`CPU: ${snapshot.cpuModel || "未知"}${snapshot.cpuPercent != null ? ` · 当前占用 ${snapshot.cpuPercent}%` : ""}`);
  lines.push(`内存: ${snapshot.memoryUsedGb} / ${snapshot.memoryTotalGb} GB（使用率 ${snapshot.memoryPercent}%）`);
  if (snapshot.gpuPercent != null) {
    let gpuLine = `GPU: 占用 ${snapshot.gpuPercent}%`;
    if (snapshot.gpuTemperature != null) gpuLine += ` · 温度 ${snapshot.gpuTemperature}°C`;
    if (snapshot.vramUsedGb != null) gpuLine += ` · 显存 ${snapshot.vramUsedGb}/${snapshot.vramTotalGb} GB`;
    lines.push(gpuLine);
  }
  lines.push(`已运行: ${snapshot.uptime.replace("已运行 ", "")}`);
  if (snapshot.batteryPercent != null) {
    lines.push(`电池: ${snapshot.batteryPercent}%（${snapshot.batteryLabel}）`);
  } else {
    lines.push("电池: 未检测到（台式机或未上报）");
  }
  return lines;
}

async function diskUsage(drive) {
  const letter = drive ? drive.toUpperCase() : "C";
  const r = await runCommand("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `$d = Get-PSDrive -Name "${letter}" -ErrorAction SilentlyContinue; if ($d) { "$($d.Used) $($d.Free)" } else { Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Size - $_.FreeSpace) $($_.FreeSpace)" } }`,
  ]);
  if (!r.ok || !r.stdout.trim()) return null;
  const [usedStr, freeStr] = r.stdout.trim().split(/\s+/);
  const used = Number(usedStr);
  const free = Number(freeStr);
  if (!Number.isFinite(used) || !Number.isFinite(free) || used + free <= 0) return null;
  return { drive: letter, used, free, total: used + free };
}

async function collectDisk(drive) {
  const d = await diskUsage(drive);
  if (!d) return `磁盘 ${drive ? drive.toUpperCase() : "系统"}: 无法读取`;
  const pct = ((d.used / d.total) * 100).toFixed(1);
  return `磁盘 ${d.drive}: 已用 ${formatBytes(d.used)} / ${formatBytes(d.total)}（${pct}%），剩余 ${formatBytes(d.free)}`;
}

const systemStatusPlugin = {
  register(ctx) {
    ctx.registerTool({
      id: "system-status_status",
      name: "系统状态查询",
      description: "查询本机系统状态，包括操作系统、CPU 占用、内存、GPU、电池与开机时长。用户问电脑还剩多少电、内存占用、CPU 温度负载、开了多久等问题时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute() {
        const lines = await collectStatus();
        return lines.join("\n");
      },
    });

    ctx.registerTool({
      id: "system-status_disk",
      name: "磁盘占用查询",
      description: "查询磁盘空间占用情况。可选指定盘符（如 C、D、E），不指定则查询系统盘。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          drive: { type: "string", description: "Windows 盘符字母，例如 C、D、E；留空查询系统所在盘" },
        },
        required: [],
      },
      async execute(args) {
        const drive = typeof args.drive === "string" && /^[a-z]$/i.test(args.drive.trim()) ? args.drive.trim().toUpperCase() : undefined;
        return collectDisk(drive);
      },
    });

    ctx.registerIpc("snapshot", () => collectSnapshot());

    ctx.log("系统状态插件已注册: system-status_status / system-status_disk");
  },

  async open() {
    if (pluginWin && !pluginWin.isDestroyed()) {
      pluginWin.focus();
      return;
    }
    const { BrowserWindow, ipcMain } = require("electron");
    const CH_MIN = "plugin:system-status:win-minimize";
    const CH_MAX = "plugin:system-status:win-maximize";
    const CH_CLOSE = "plugin:system-status:win-close";
    pluginWin = new BrowserWindow({
      width: 860,
      height: 600,
      minWidth: 380,
      minHeight: 420,
      frame: false, // 无系统边框，标题栏由 ui.html 自绘
      resizable: true,
      autoHideMenuBar: true,
      backgroundColor: "#fff9fc",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    // 自定义标题栏的窗口控制：渲染进程发事件，主进程执行
    const onMin = () => { if (pluginWin && !pluginWin.isDestroyed()) pluginWin.minimize(); };
    const onMax = () => {
      if (!pluginWin || pluginWin.isDestroyed()) return;
      if (pluginWin.isMaximized()) pluginWin.unmaximize();
      else pluginWin.maximize();
    };
    const onClose = () => { if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close(); };
    ipcMain.on(CH_MIN, onMin);
    ipcMain.on(CH_MAX, onMax);
    ipcMain.on(CH_CLOSE, onClose);
    pluginWin.on("closed", () => {
      ipcMain.removeListener(CH_MIN, onMin);
      ipcMain.removeListener(CH_MAX, onMax);
      ipcMain.removeListener(CH_CLOSE, onClose);
      pluginWin = null;
    });
    await pluginWin.loadFile(path.join(__dirname, "ui.html"));
  },

  unregister() {
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
  },
};

module.exports = systemStatusPlugin;
module.exports.default = systemStatusPlugin;
