// 内置高危工具 — 给 agent 装上 fetch_url / run_shell / install_mcp_server 三件武器
// 全部走权限网关：fetch_url=network, run_shell=shell, install_mcp_server=fs-write

import { spawn } from "child_process";
import { toolRegistry } from "./tool-registry";
import { addMcpServer } from "./mcp-manager";

const LOG_PREFIX = "[BuiltinTools]";

// ── 工具 1：fetch_url ─────────────────────────────────────
// 拉一个 URL 的纯文本 / Markdown 形式的 body，给 agent 读 README 用

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 512 * 1024; // 单次最多 512KB，防止 LLM 上下文爆炸

// HTML → Markdown 清洗：用 turndown 转成 LLM 最易理解的 markdown 格式
// 保留标题层级/列表/代码块/表格/链接，比纯 strip 标签信息量大得多
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",        // <h1>→# <h2>→##
  codeBlockStyle: "fenced",   // <pre><code>→```围栏代码块（LLM 更认）
  bulletListMarker: "-",
  emDelimiter: "*",           // <em>→*斜体*
});

function stripHtml(html: string): string {
  // 先去 script/style/注释（turndown 不会自动去这些，留着会污染 markdown）
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // 转 markdown（保留结构），失败则退回纯 strip 标签
  try {
    const md = turndown.turndown(s);
    // 压缩多余空行（turndown 有时会留连续空行）
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // turndown 解析失败（畸形 HTML），退回原来的纯标签剥离
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }
}

async function executeFetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return "[错误] url 必须以 http:// 或 https:// 开头";
  }
  const asMarkdown = args.format === "markdown" || args.format === undefined;
  console.log(LOG_PREFIX, "fetch_url:", url, "format=" + (asMarkdown ? "markdown" : "raw"));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Cyrene Agent) Chrome/120 Safari/537.36",
        Accept: "text/html,text/markdown,text/plain,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      return "[错误] HTTP " + resp.status + " " + resp.statusText;
    }
    const ctype = resp.headers.get("content-type") || "";
    const buf = await resp.arrayBuffer();
    const truncated = buf.byteLength > FETCH_MAX_BYTES;
    const slice = truncated ? buf.slice(0, FETCH_MAX_BYTES) : buf;
    let text = new TextDecoder("utf-8").decode(slice);
    if (asMarkdown && /text\/html|application\/xhtml/i.test(ctype)) {
      text = stripHtml(text);
    }
    const meta = "URL: " + url + "\nContent-Type: " + ctype + (truncated ? "\n[已截断到 " + FETCH_MAX_BYTES + " 字节]" : "") + "\n\n";
    return meta + text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] fetch 失败: " + msg;
  } finally {
    clearTimeout(timer);
  }
}

toolRegistry.register({
  id: "fetch_url",
  name: "读取网页",
  description:
    "下载指定 URL 的网页内容并返回正文。HTML 会用 turndown 转成结构化 markdown" +
    "（保留标题/列表/代码块/表格），便于阅读。\n\n" +
    "何时用：\n" +
    "- 用户给了明确的网址（https://...），想看内容\n" +
    "- 用户说'看看这个链接''读一下这个网页'\n" +
    "- 需要读 GitHub README、MCP 安装文档、API 文档等具体页面\n" +
    "- web_search 之后拿到链接，想看具体内容\n\n" +
    "不要用于：\n" +
    "- 用户只给关键词没给网址 → 用 web_search\n" +
    "- 用户问'今天有什么新闻' → 用 web_search\n" +
    "- 本地文件路径 → 用 read_file\n\n" +
    "参数：url (必填，完整 http(s) 地址)，format (可选 markdown|raw，默认 markdown)。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "要拉取的完整 URL（必须包含 https:// 或 http://）" },
      format: { type: "string", description: "markdown=自动清洗 HTML 为纯文本（默认）；raw=原文不处理" },
    },
    required: ["url"],
  },
  execute: executeFetchUrl,
});

// ── 工具 2：run_shell ─────────────────────────────────────
// 在用户机器上跑一行命令，给 agent 装 MCP 时跑 git/npm/pip 等用
// 注意：不开 shell（spawn shell:false），命令必须是真正的可执行文件，避免 shell 注入

const SHELL_TIMEOUT_MS = 5 * 60_000; // 5 分钟兜底
const SHELL_MAX_OUTPUT = 16 * 1024;  // 单次最多 16KB stdout/stderr

interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function runShellOnce(command: string, args: string[], cwd?: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd || undefined,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const timeoutTimer = setTimeout(() => {
      console.warn(LOG_PREFIX, "run_shell 超时，kill:", command);
      child.kill("SIGKILL");
    }, SHELL_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < SHELL_MAX_OUTPUT) {
        stdout += chunk.toString("utf8");
        if (stdout.length > SHELL_MAX_OUTPUT) {
          stdout = stdout.slice(0, SHELL_MAX_OUTPUT);
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < SHELL_MAX_OUTPUT) {
        stderr += chunk.toString("utf8");
        if (stderr.length > SHELL_MAX_OUTPUT) {
          stderr = stderr.slice(0, SHELL_MAX_OUTPUT);
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + "\n[spawn error] " + err.message,
        truncated,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      resolve({ exitCode: code, stdout, stderr, truncated });
    });
  });
}

async function executeRunShell(args: Record<string, unknown>): Promise<string> {
  const cmd = String(args.command || "").trim();
  const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map((x) => String(x)) : [];
  const cwd = args.cwd ? String(args.cwd) : undefined;
  if (!cmd) return "[错误] command 不能为空";

  console.log(LOG_PREFIX, "run_shell:", cmd, JSON.stringify(cmdArgs), cwd ? "cwd=" + cwd : "");
  const result = await runShellOnce(cmd, cmdArgs, cwd);
  console.log(LOG_PREFIX, "run_shell 完成 exitCode=" + result.exitCode + " stdout.len=" + result.stdout.length + " stderr.len=" + result.stderr.length);

  const lines: string[] = [];
  lines.push("$ " + cmd + (cmdArgs.length ? " " + cmdArgs.join(" ") : ""));
  if (cwd) lines.push("(cwd: " + cwd + ")");
  lines.push("exitCode: " + result.exitCode);
  if (result.stdout) lines.push("--- stdout ---\n" + result.stdout.trimEnd());
  if (result.stderr) lines.push("--- stderr ---\n" + result.stderr.trimEnd());
  if (result.truncated) lines.push("[输出已截断]");
  return lines.join("\n");
}

toolRegistry.register({
  id: "run_shell",
  name: "执行命令",
  description:
    "在用户电脑上执行一条命令（不通过 shell，按 argv 数组传参）。返回 exitCode + stdout + stderr。\n\n" +
    "何时用：\n" +
    "- git clone / git status / git log 等版本控制操作\n" +
    "- npm install / npm run / pip install / node xxx.js 等开发操作\n" +
    "- node --version / python --version 等查环境\n" +
    "- 用户明确要求'跑一下这条命令'\n\n" +
    "不要用于：\n" +
    "- 读文件 → read_file（更安全）\n" +
    "- 列目录 → list_dir\n" +
    "- 下载网页 → fetch_url\n" +
    "- 能用专用工具完成的事\n\n" +
    "高风险：会真实修改用户系统。危险命令需用户在权限档位授权或单次同意。" +
    "参数：command (可执行文件名或绝对路径)，args (字符串数组)，cwd (可选工作目录)。",
  enabled: true,
  risk: "shell",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "可执行文件名（如 'git'、'npm'）或绝对路径" },
      args: { type: "array", description: "命令行参数，按 argv 数组形式给，例如 ['clone', 'https://...']" },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
    },
    required: ["command"],
  },
  execute: executeRunShell,
});

// ── 工具 3：install_mcp_server ────────────────────────────
// 把一个 {command, args, env} 注册成新的 MCP server。
// agent 读完 README 的 mcpServers 配置后，调这个工具一次性写盘 + 启动 + 发现工具

async function executeInstallMcp(args: Record<string, unknown>): Promise<string> {
  const id = (String(args.id || "").trim()) || ("mcp-" + Date.now());
  const name = String(args.name || "").trim() || id;
  const command = String(args.command || "").trim();
  if (!command) return "[错误] command 不能为空";

  const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map((x) => String(x)) : [];
  let env: Record<string, string> | undefined;
  if (args.env && typeof args.env === "object") {
    env = {};
    for (const [k, v] of Object.entries(args.env as Record<string, unknown>)) {
      env[k] = String(v);
    }
  }
  const cwd = args.cwd ? String(args.cwd) : undefined;

  console.log(LOG_PREFIX, "install_mcp_server:", id, name, command, JSON.stringify(cmdArgs).slice(0, 200));
  if (env) console.log(LOG_PREFIX, "  env keys:", Object.keys(env).join(","));
  if (cwd) console.log(LOG_PREFIX, "  cwd:", cwd);

  try {
    const result = await addMcpServer({
      id,
      name,
      transport: "stdio",
      command,
      args: cmdArgs,
      env,
      cwd,
    });
    if (!result.ok) {
      return "[错误] 安装失败: " + (result.error || "未知错误");
    }
    const tools = result.toolIds || [];
    return (
      "✅ MCP server \"" + name + "\" 已连接\n" +
      "id: " + id + "\n" +
      "command: " + command + (cmdArgs.length ? " " + cmdArgs.join(" ") : "") + "\n" +
      "发现 " + tools.length + " 个工具" + (tools.length ? "：\n  - " + tools.join("\n  - ") : "") + "\n" +
      "你现在可以让我用这些工具帮你做事。"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 安装异常: " + msg;
  }
}

toolRegistry.register({
  id: "install_mcp_server",
  name: "安装 MCP",
  description:
    "把一个 MCP server 加到昔涟的工具盘里：写入配置 → 启动 → 发现工具。\n\n" +
    "何时用：\n" +
    "- 用户明确要装某个 MCP server（'帮我装 xxx mcp'）\n" +
    "- 用户给了 MCP 的 GitHub 仓库或配置\n\n" +
    "推荐流程：先用 fetch_url 读 README，找到 mcpServers 配置块" +
    "（command/args/env），再用本工具一次性安装。\n\n" +
    "不要用于：\n" +
    "- 日常工具调用（已注册的工具直接用）\n" +
    "- 系统软件安装（那是 run_shell 的活）\n\n" +
    "参数：id (可选，唯一标识，留空则用时间戳)，name (展示名)，command (可执行命令)，" +
    "args (字符串数组)，env (键值对，环境变量)，cwd (可选工作目录)。",
  enabled: true,
  risk: "fs-write",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "唯一标识，留空则自动生成" },
      name: { type: "string", description: "展示名，比如 'mail-mcp'" },
      command: { type: "string", description: "可执行命令，例如 'node' / 'pythonw' / 'npx'" },
      args: { type: "array", description: "命令行参数数组，例如 ['C:/.../bridging_mail_mcp.py']" },
      env: { type: "object", description: "环境变量键值对" },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
    },
    required: ["command"],
  },
  execute: executeInstallMcp,
});

console.log(LOG_PREFIX, "已注册：fetch_url / run_shell / install_mcp_server");

// ── 工具 4：weather（天气查询）─────────────────────────────
// 查指定城市的实时天气。城市参数可选——没传就读用户信息的默认城市。
// 支持两个天气源：
//   - open-meteo（免配置默认，海外开源 API）
//   - amap（高德天气，国内数据准，需填 key）
// 默认城市/天气源/高德key 通过 setWeatherConfig 注入（避免 import index.ts 造成循环依赖）。

const WEATHER_TIMEOUT_MS = 15_000;

/** 注入的配置获取器（由 index.ts 启动时调 setWeatherConfig 设置）。 */
let weatherCityGetter: (() => string) | null = null;
let weatherSourceGetter: (() => string) | null = null;
let amapKeyGetter: (() => string) | null = null;

/** 天气卡片数据回调：工具拿到结构化数据后调这个，由桥层发 Custom 事件给渲染端。 */
let weatherCardCallback: ((card: WeatherCardData) => void) | null = null;

/** 天气卡片结构化数据（发给渲染端渲染 MBE 卡片用）。 */
export interface WeatherCardData {
  city: string;
  adm: string;
  temp: number;
  feelsLike: number;
  text: string;
  icon: string;
  hi?: number;
  lo?: number;
  humidity: number;
  windDir: string;
  windScale: string;
  precip: number;
  pressure: number;
  visibility?: number;
  uv?: string;
  aqi?: number;
  aqiText?: string;
  source: string;
  updateTime: string;
}

/** WMO 天气代码 → emoji 图标。 */
function weatherIconFromCode(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 2) return "⛅";
  if (code === 3) return "☁️";
  if (code >= 45 && code <= 48) return "🌫️";
  if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67)) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌤️";
}

/** 高德天气文字 → emoji 图标。 */
function weatherIconFromText(text: string): string {
  if (/晴/.test(text)) return "☀️";
  if (/雷/.test(text)) return "⛈️";
  if (/大雨|暴雨/.test(text)) return "🌧️";
  if (/雨/.test(text)) return "🌦️";
  if (/大雪|暴雪/.test(text)) return "❄️";
  if (/雪/.test(text)) return "🌨️";
  if (/雾|霾/.test(text)) return "🌫️";
  if (/阴/.test(text)) return "☁️";
  if (/云|多云/.test(text)) return "⛅";
  if (/风/.test(text)) return "💨";
  return "🌤️";
}

/** AQI → 等级文字 + 颜文字。 */
function aqiKaomoji(aqi: number): { text: string; kaomoji: string } {
  if (aqi <= 50) return { text: "优", kaomoji: "(◕‿◕)" };
  if (aqi <= 100) return { text: "良", kaomoji: "(´ー`)" };
  if (aqi <= 150) return { text: "轻度污染", kaomoji: "(´-ω-`)" };
  if (aqi <= 200) return { text: "中度污染", kaomoji: "(；´д`)" };
  return { text: "重度污染", kaomoji: "(╥﹏╥)" };
}

/** 紫外线指数 → 文字。 */
function uvText(uv: number): string {
  if (uv <= 2) return "弱";
  if (uv <= 5) return "中等";
  if (uv <= 7) return "强";
  if (uv <= 10) return "很强";
  return "极强";
}

/**
 * index.ts 启动时调用，注入默认城市/天气源/高德key/卡片回调 的读取器。
 * source: "open-meteo"（免配置默认）| "amap"（高德）
 */
export function setWeatherConfig(
  cityGetter: () => string,
  sourceGetter: () => string,
  amapKeyFn: () => string,
  cardCb?: (card: WeatherCardData) => void,
): void {
  weatherCityGetter = cityGetter;
  weatherSourceGetter = sourceGetter;
  amapKeyGetter = amapKeyFn;
  if (cardCb) weatherCardCallback = cardCb;
}

// ── Open-Meteo 实现（免 key 免配置）──

interface OMCity { name: string; latitude: number; longitude: number; country: string; admin1?: string }

/** Open-Meteo 城市查询（Geocoding API，免费免 key）。 */
async function omResolveCity(city: string): Promise<OMCity | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = await resp.json() as { results?: OMCity[] };
    if (!data.results || data.results.length === 0) return null;
    return data.results[0];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Open-Meteo 实时天气查询（免费免 key）。 */
async function omFetchWeather(city: string): Promise<string> {
  const loc = await omResolveCity(city);
  if (!loc) {
    return `[错误] 找不到城市"${city}"，请确认城市名（支持中文/拼音）。`;
  }
  const params = [
    "temperature_2m", "relative_humidity_2m", "apparent_temperature",
    "precipitation", "weather_code", "wind_speed_10m", "wind_direction_10m",
    "surface_pressure",
  ].join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=${params}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[错误] 天气查询失败：HTTP ${resp.status}`;
    const data = await resp.json() as {
      current?: {
        temperature_2m: number; relative_humidity_2m: number; apparent_temperature: number;
        precipitation: number; weather_code: number; wind_speed_10m: number;
        wind_direction_10m: number; surface_pressure: number;
      };
    };
    const c = data.current;
    if (!c) return "[错误] 天气查询失败：Open-Meteo 未返回数据";
    const wmoText = omWeatherCodeText(c.weather_code);
    const windDir = omWindDir(c.wind_direction_10m);
    const adm = loc.admin1 ? `${loc.admin1}` : loc.country;
    const icon = weatherIconFromCode(c.weather_code);

    // 发送天气卡片数据给渲染端
    if (weatherCardCallback) {
      weatherCardCallback({
        city: loc.name, adm, temp: c.temperature_2m, feelsLike: c.apparent_temperature,
        text: wmoText, icon,
        humidity: c.relative_humidity_2m, windDir, windScale: `${c.wind_speed_10m}km/h`,
        precip: c.precipitation, pressure: Math.round(c.surface_pressure),
        source: "Open-Meteo", updateTime: new Date().toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      });
    }

    return [
      `城市：${loc.name}（${adm}）`,
      `天气：${wmoText}`,
      `温度：${c.temperature_2m}°C（体感 ${c.apparent_temperature}°C）`,
      `风向风速：${windDir} ${c.wind_speed_10m}km/h`,
      `湿度：${c.relative_humidity_2m}%`,
      `降水量：${c.precipitation}mm`,
      `气压：${c.surface_pressure}hPa`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 天气查询失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** WMO 天气代码 → 中文描述（Open-Meteo 用 WMO 标准代码）。 */
function omWeatherCodeText(code: number): string {
  const map: Record<number, string> = {
    0: "晴", 1: "晴间多云", 2: "多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "小雨", 53: "中雨", 55: "大雨",
    56: "冻雨", 57: "强冻雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪",
    77: "雪粒",
    80: "阵雨", 81: "强阵雨", 82: "暴雨",
    85: "阵雪", 86: "强阵雪",
    95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
  };
  return map[code] ?? `未知（代码${code}）`;
}

/** 风向角度 → 中文方位。 */
function omWindDir(deg: number): string {
  const dirs = ["北", "东北偏北", "东北", "东北偏东", "东", "东南偏东", "东南", "东南偏南",
    "南", "西南偏南", "西南", "西南偏西", "西", "西北偏西", "西北", "西北偏北"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── 高德天气实现（需 key，国内数据准）──

interface AmapDistrict { adcode: string; name: string; level: string }

/** 高德行政区查询：城市名 → adcode。 */
async function amapResolveAdcode(city: string, key: string): Promise<AmapDistrict | null> {
  const url = `https://restapi.amap.com/v3/config/district?keywords=${encodeURIComponent(city)}&subdistrict=0&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = await resp.json() as { status?: string; districts?: AmapDistrict[] };
    if (data.status !== "1" || !data.districts || data.districts.length === 0) return null;
    return data.districts[0];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 高德实时天气查询。 */
async function amapFetchWeather(city: string, key: string): Promise<string> {
  const district = await amapResolveAdcode(city, key);
  if (!district) {
    return `[错误] 找不到城市"${city}"，请确认城市名（支持中文，如"无锡"）。`;
  }
  const url = `https://restapi.amap.com/v3/weather/weatherInfo?city=${district.adcode}&extensions=base&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[错误] 天气查询失败：HTTP ${resp.status}`;
    const data = await resp.json() as { status?: string; lives?: Array<{
      province: string; city: string; weather: string; temperature: string;
      winddirection: string; windpower: string; humidity: string; reporttime: string;
    }> };
    if (data.status !== "1" || !data.lives || data.lives.length === 0) {
      return `[错误] 天气查询失败：高德返回 status=${data.status ?? "?"}`;
    }
    const w = data.lives[0];
    const icon = weatherIconFromText(w.weather);

    // 发送天气卡片数据给渲染端
    if (weatherCardCallback) {
      weatherCardCallback({
        city: w.city, adm: w.province, temp: Number(w.temperature), feelsLike: Number(w.temperature),
        text: w.weather, icon,
        humidity: Number(w.humidity), windDir: w.winddirection, windScale: `${w.windpower}级`,
        precip: 0, pressure: 0,
        source: "高德天气", updateTime: w.reporttime.slice(11, 16) || new Date().toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      });
    }

    return [
      `城市：${w.city}（${w.province}）`,
      `天气：${w.weather}`,
      `温度：${w.temperature}°C`,
      `风向风速：${w.winddirection}风 ${w.windpower}级`,
      `湿度：${w.humidity}%`,
      `发布时间：${w.reporttime}`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 天气查询失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

async function executeWeather(args: Record<string, unknown>): Promise<string> {
  const source = weatherSourceGetter?.() ?? "open-meteo";

  // 城市：参数优先，没传读用户信息默认城市
  let city = String(args.city ?? "").trim();
  if (!city) {
    city = (weatherCityGetter?.() ?? "").trim();
  }
  if (!city) {
    return "[提示] 没有指定城市，也没设置默认城市。请告诉用户：在 设置 → 我的信息 填默认城市，或直接说出要查的城市名。";
  }

  // 按天气源分支
  if (source === "open-meteo") {
    return omFetchWeather(city);
  }
  if (source === "amap") {
    const amapKey = amapKeyGetter?.() ?? "";
    if (!amapKey) {
      return "[错误] 还没有配置高德天气 Key。请在 设置 → 插件 → 天气查询 填入高德 Key，或切换天气源为 Open-Meteo（免配置）。";
    }
    return amapFetchWeather(city, amapKey);
  }

  // 未知天气源
  return `[错误] 未知的天气源"${source}"。请在 设置 → 插件 → 天气查询 选择 Open-Meteo 或 高德天气。`;
}

toolRegistry.register({
  id: "weather",
  name: "查天气",
  description:
    "查询指定城市的实时天气。返回温度、体感温度、湿度、风速风向、降水、日出日落、AQI、UV 等。\n\n" +
    "何时用：\n" +
    "- 用户问'今天天气怎样''外面冷不冷''热不热''要不要带伞''穿什么'\n" +
    "- 用户提到城市名 + 天气相关词\n" +
    "- 用户问'周末适合出去玩吗'且涉及天气判断\n\n" +
    "不要用于：\n" +
    "- 历史天气（'上周北京天气'）—— 做不到，直接告诉用户\n" +
    "- 逐小时精确预报\n" +
    "- 完全跟天气无关的问题\n\n" +
    "参数：city（可选，城市名中文或拼音；不传则用用户设置的默认城市）。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "要查询的城市名（中文或拼音），不传则用用户默认城市" },
    },
    required: [],
  },
  execute: executeWeather,
});

// ── 工具 5：web_search（博查搜索）─────────────────────────
// 联网搜索：给关键词，返回搜索结果（标题/链接/摘要）。博查 API 返回 AI 友好的结构化数据。
// key 通过 setSearchConfig 注入（避免 import index.ts 造成循环依赖）。

const SEARCH_TIMEOUT_MS = 20_000;

/** 注入的搜索配置获取器。 */
let searchEngineGetter: (() => string) | null = null;
let searchBochaKeyGetter: (() => string) | null = null;
let searchTavilyKeyGetter: (() => string) | null = null;

/**
 * index.ts 启动时调用，注入搜索引擎/各源key 的读取器。
 * engine: "off" | "bocha" | "tavily" | "volcano" | "minimax"
 */
export function setSearchConfig(
  engineGetter: () => string,
  bochaKeyGetter: () => string,
  tavilyKeyGetter: () => string,
): void {
  searchEngineGetter = engineGetter;
  searchBochaKeyGetter = bochaKeyGetter;
  searchTavilyKeyGetter = tavilyKeyGetter;
}

interface BochaResult {
  name: string;
  url: string;
  snippet: string;
  summary?: string;
  siteName?: string;
}

/** 博查搜索：调 /v1/web-search，返回结构化文本给模型。 */
async function bochaSearch(query: string, key: string): Promise<string> {
  const url = "https://api.bochaai.com/v1/web-search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        count: 8,
        summary: true,
      }),
    });
    if (!resp.ok) {
      return `[错误] 搜索失败：HTTP ${resp.status}`;
    }
    // 博查 API 响应包了一层 { code, data: { webPages: { value: [...] } } }
    // 兼容旧结构（直接 webPages）和新结构（data.webPages）
    const raw = await resp.json() as {
      webPages?: { value?: BochaResult[] };
      data?: { webPages?: { value?: BochaResult[] } };
    };
    const results = raw.data?.webPages?.value ?? raw.webPages?.value ?? [];
    if (results.length === 0) {
      return `[提示] 搜索"${query}"没有找到结果。`;
    }
    // 格式化成模型易读的文本
    const lines: string[] = [`搜索"${query}"的结果（共 ${results.length} 条）：`, ""];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`【${i + 1}】${r.name}`);
      if (r.siteName) lines.push(`  来源：${r.siteName}`);
      lines.push(`  链接：${r.url}`);
      lines.push(`  摘要：${r.summary || r.snippet || "（无摘要）"}`);
      lines.push("");
    }
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 搜索失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** Tavily 搜索：调 /search，返回结构化文本给模型。 */
async function tavilySearch(query: string, key: string): Promise<string> {
  const url = "https://api.tavily.com/search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: 8,
        include_answer: true,
      }),
    });
    if (!resp.ok) {
      return `[错误] 搜索失败：HTTP ${resp.status}`;
    }
    const data = await resp.json() as {
      answer?: string;
      results?: Array<{ title: string; url: string; content: string }>;
    };
    const results = data.results ?? [];
    if (results.length === 0) {
      return `[提示] 搜索"${query}"没有找到结果。`;
    }
    const lines: string[] = [`搜索"${query}"的结果（共 ${results.length} 条）：`, ""];
    if (data.answer) {
      lines.push(`摘要：${data.answer}`, "");
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`【${i + 1}】${r.title}`);
      lines.push(`  链接：${r.url}`);
      lines.push(`  摘要：${r.content || "（无摘要）"}`);
      lines.push("");
    }
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 搜索失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

async function executeWebSearch(args: Record<string, unknown>): Promise<string> {
  const engine = searchEngineGetter?.() ?? "off";
  if (engine === "off") {
    return "[提示] 联网搜索未启用。请在 设置 → 插件 → 联网搜索 选择搜索源并填入 Key。";
  }

  const query = String(args.query ?? "").trim();
  if (!query) {
    return "[提示] 请提供搜索关键词。";
  }

  if (engine === "bocha") {
    const key = searchBochaKeyGetter?.() ?? "";
    if (!key) {
      return "[错误] 还没有配置博查搜索 Key。请在 设置 → 插件 → 联网搜索 填入博查 Key。";
    }
    return bochaSearch(query, key);
  }

  if (engine === "tavily") {
    const key = searchTavilyKeyGetter?.() ?? "";
    if (!key) {
      return "[错误] 还没有配置 Tavily 搜索 Key。请在 设置 → 插件 → 联网搜索 填入 Tavily Key。";
    }
    return tavilySearch(query, key);
  }

  // 其他搜索引擎暂未接入
  return `[提示] 搜索引擎"${engine}"暂未接入，目前支持 bocha 和 tavily。`;
}

toolRegistry.register({
  id: "web_search",
  name: "联网搜索",
  description:
    "搜索互联网获取实时信息。返回搜索结果的标题、链接和摘要。\n\n" +
    "何时用：\n" +
    "- 用户问'最近有什么新闻''搜一下 xxx 怎么用''xxx 是什么'\n" +
    "- 用户问的事需要联网才能知道（股价、赛事、最新技术）\n" +
    "- 用户只给关键词，没给具体网址\n\n" +
    "不要用于：\n" +
    "- 用户已经给了明确网址 → 用 fetch_url\n" +
    "- 用户问本机文件 → read_file / list_dir\n" +
    "- 能凭已有知识直接回答的简单问题\n\n" +
    "参数：query（必填，搜索关键词）。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
    },
    required: ["query"],
  },
  execute: executeWebSearch,
});

// ── 工具：todo_write ──────────────────────────────────────
// 任务拆解可视化工具。让昔涟能像 Claude Code 一样把复杂任务拆成步骤展示给用户。
// 每次调用整体覆盖当前清单（不是增量）。store 持久化 + 通知主进程转发 CUSTOM 事件。

import { setTodos, getTodos, clearTodos, type TodoItem } from "./todo-store";

toolRegistry.register({
  id: "todo_write",
  name: "任务清单",
  description:
    "更新当前任务清单（todo list）。用于把复杂任务拆解成可执行步骤，让用户看到进度。\n\n" +
    "何时用：\n" +
    "- 用户给的任务有 2 步以上（'帮我查 X 然后整理成报告'）\n" +
    "- 用户要求'规划一下''拆解一下''分步骤完成'\n" +
    "- 你自己判断这个任务需要多轮工具调用才能完成\n\n" +
    "不要用于：\n" +
    "- 简单问答（一句话能答完）\n" +
    "- 纯闲聊\n" +
    "- 已经在 todo 里的步骤更新（直接整体覆盖即可）\n\n" +
    "用法：每次调用用完整列表覆盖（不是增量）。status 用 pending/in_progress/completed。\n" +
    "开始做某一步时把它标 in_progress，做完标 completed。\n" +
    "完成所有步骤后调一次空列表清空，表示任务结束。",
  enabled: true,
  risk: "safe",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "任务列表。完整覆盖当前清单。空数组表示清空（任务结束）。",
        items: {
          type: "object",
          properties: {
            id:       { type: "string", description: "任务唯一标识，如 '1' '2' '3'" },
            content:  { type: "string", description: "任务描述" },
            status:   { type: "string", description: "状态：pending(待办) / in_progress(进行中) / completed(已完成)" },
            priority: { type: "string", description: "可选优先级：high/medium/low" },
          },
        },
      },
    },
    required: ["todos"],
  },
  execute: async (args) => {
    const items = (args.todos || []) as TodoItem[];

    // 空列表 = 清空（任务结束）
    if (items.length === 0) {
      clearTodos();
      return "[todo_write] 已清空任务清单（任务结束）";
    }

    const state = setTodos(items);

    // 返回给 LLM 的简短摘要，不返回全部内容（避免 token 浪费）
    const counts = items.reduce((acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return "[todo_write] 已更新任务清单：共 " + items.length + " 项，" +
      "进行中 " + (counts.in_progress || 0) + " / " +
      "已完成 " + (counts.completed || 0) + " / " +
      "待办 " + (counts.pending || 0) +
      "。updatedAt=" + state.updatedAt;
  },
});

// 暴露给 index.ts 在 startup 调用，避免 tree-shake 掉
export { loadTodos, onTodosChange, getTodos as getCurrentTodos } from "./todo-store";

console.log(LOG_PREFIX, "已注册：fetch_url / run_shell / install_mcp_server / weather / web_search");
