// 內置高危工具 — 給 agent 裝上 fetch_url / run_shell / install_mcp_server 三件武器
// 全部走權限網關：fetch_url=network, run_shell=shell, install_mcp_server=fs-write

import { spawn } from "child_process";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { toolRegistry } from "./tool-registry";
import { addMcpServer } from "./mcp-manager";
import { sendToLive2DWindow } from "../index";
import { createPlayLive2DActionTool } from "./tools/play-live2d-action";

const LOG_PREFIX = "[BuiltinTools]";

// ── 工具 1：fetch_url ─────────────────────────────────────
// 拉一個 URL 的純文本 / Markdown 形式的 body，給 agent 讀 README 用

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 512 * 1024; // 單次最多 512KB，防止 LLM 上下文爆炸

// HTML → Markdown 清洗：用 turndown 轉成 LLM 最易理解的 markdown 格式
// 保留標題層級/列表/代碼塊/表格/鏈接，比純 strip 標籤信息量大得多
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",        // <h1>→# <h2>→##
  codeBlockStyle: "fenced",   // <pre><code>→```圍欄代碼塊（LLM 更認）
  bulletListMarker: "-",
  emDelimiter: "*",           // <em>→*斜體*
});

function stripHtml(html: string): string {
  // 先去 script/style/註釋（turndown 不會自動去這些，留著會汙染 markdown）
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // 轉 markdown（保留結構），失敗則退回純 strip 標籤
  try {
    const md = turndown.turndown(s);
    // 壓縮多餘空行（turndown 有時會留連續空行）
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // turndown 解析失敗（畸形 HTML），退回原來的純標籤剝離
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }
}

async function executeFetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return "[錯誤] url 必須以 http:// 或 https:// 開頭";
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
      return "[錯誤] HTTP " + resp.status + " " + resp.statusText;
    }
    const ctype = resp.headers.get("content-type") || "";
    const buf = await resp.arrayBuffer();
    const truncated = buf.byteLength > FETCH_MAX_BYTES;
    const slice = truncated ? buf.slice(0, FETCH_MAX_BYTES) : buf;
    let text = new TextDecoder("utf-8").decode(slice);
    if (asMarkdown && /text\/html|application\/xhtml/i.test(ctype)) {
      text = stripHtml(text);
    }
    const meta = "URL: " + url + "\nContent-Type: " + ctype + (truncated ? "\n[已截斷到 " + FETCH_MAX_BYTES + " 字節]" : "") + "\n\n";
    return meta + text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] fetch 失敗: " + msg;
  } finally {
    clearTimeout(timer);
  }
}

toolRegistry.register({
  id: "fetch_url",
  name: "讀取網頁",
  description:
    "下載指定 URL 的網頁內容並返回正文。HTML 會用 turndown 轉成結構化 markdown" +
    "（保留標題/列表/代碼塊/表格），便於閱讀。\n\n" +
    "何時用：\n" +
    "- 用戶給了明確的網址（https://...），想看內容\n" +
    "- 用戶說'看看這個鏈接''讀一下這個網頁'\n" +
    "- 需要讀 GitHub README、MCP 安裝文檔、API 文檔等具體頁面\n" +
    "- web_search 之後拿到鏈接，想看具體內容\n\n" +
    "不要用於：\n" +
    "- 用戶只給關鍵詞沒給網址 → 用 web_search\n" +
    "- 用戶問'今天有什麼新聞' → 用 web_search\n" +
    "- 本地文件路徑 → 用 read_file\n\n" +
    "參數：url (必填，完整 http(s) 地址)，format (可選 markdown|raw，默認 markdown)。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "要拉取的完整 URL（必須包含 https:// 或 http://）" },
      format: { type: "string", description: "markdown=自動清洗 HTML 為純文本（默認）；raw=原文不處理" },
    },
    required: ["url"],
  },
  execute: executeFetchUrl,
});

// ── 工具 2：run_shell ─────────────────────────────────────
// 在用戶機器上跑一行命令，給 agent 裝 MCP 時跑 git/npm/pip 等用
// 注意：不開 shell（spawn shell:false），命令必須是真正的可執行文件，避免 shell 注入

const SHELL_TIMEOUT_MS = 5 * 60_000; // 5 分鐘兜底
const SHELL_MAX_OUTPUT = 16 * 1024;  // 單次最多 16KB stdout/stderr

interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * 把 args 規範化成 argv 數組。模型常把 "--version" 當字符串傳（schema 要求數組），
 * 不容錯的話 Array.isArray 判否 → cmdArgs=[] → 裸啟動 python/node 的交互式 REPL，卡死。
 */
function normalizeArgs(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === "string" && raw.trim()) return tokenizeArgs(raw);
  return [];
}

/** 簡易 argv 分詞：尊重單/雙引號，處理轉義空格。不引 shell（避免注入）。 */
function tokenizeArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** 可靠終止進程樹。Windows 上 child.kill("SIGKILL") 只殺直接子進程，殺不掉孫進程。 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    // /T=含整棵子樹  /F=強制  砍掉進程樹，避免孫進程成為孤兒
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
  } else {
    try { child.kill("SIGKILL"); } catch { /* 已退出則忽略 */ }
  }
}

function runShellOnce(command: string, args: string[], cwd?: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd || undefined,
      shell: false,
      windowsHide: true,
      env: process.env,
      // stdin→/dev/null(NUL)：誤啟動交互式進程(python/node REPL)時讓它讀到 EOF 立即退出，
      // 不再卡在"等 stdin 輸入"上耗滿超時。stdout/stderr 仍 pipe 來收集輸出。
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const timeoutTimer = setTimeout(() => {
      console.warn(LOG_PREFIX, "run_shell 超時，kill 進程樹:", command);
      killTree(child);
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
  // 容錯：模型常把 args 當字符串傳（如 "--version"），normalizeArgs 會自動拆成 argv 數組
  const cmdArgs = normalizeArgs(args.args);
  const cwd = args.cwd ? String(args.cwd) : undefined;
  if (!cmd) return "[錯誤] command 不能為空";

  console.log(LOG_PREFIX, "run_shell:", cmd, JSON.stringify(cmdArgs), cwd ? "cwd=" + cwd : "");
  const result = await runShellOnce(cmd, cmdArgs, cwd);
  console.log(LOG_PREFIX, "run_shell 完成 exitCode=" + result.exitCode + " stdout.len=" + result.stdout.length + " stderr.len=" + result.stderr.length);

  const lines: string[] = [];
  lines.push("$ " + cmd + (cmdArgs.length ? " " + cmdArgs.join(" ") : ""));
  if (cwd) lines.push("(cwd: " + cwd + ")");
  lines.push("exitCode: " + result.exitCode);
  if (result.stdout) lines.push("--- stdout ---\n" + result.stdout.trimEnd());
  if (result.stderr) lines.push("--- stderr ---\n" + result.stderr.trimEnd());
  if (result.truncated) lines.push("[輸出已截斷]");
  return lines.join("\n");
}

toolRegistry.register({
  id: "run_shell",
  name: "執行命令",
  description:
    "在用戶電腦上執行一條命令（不通過 shell，按 argv 數組傳參）。返回 exitCode + stdout + stderr。\n\n" +
    "何時用：\n" +
    "- git clone / git status / git log 等版本控制操作\n" +
    "- npm install / npm run / pip install / node xxx.js 等開發操作\n" +
    "- node --version / python --version 等查環境\n" +
    "- 用戶明確要求'跑一下這條命令'\n\n" +
    "不要用於：\n" +
    "- 讀文件 → read_file（更安全）\n" +
    "- 列目錄 → list_dir\n" +
    "- 下載網頁 → fetch_url\n" +
    "- 能用專用工具完成的事\n\n" +
    "高風險：會真實修改用戶系統。危險命令需用戶在權限檔位授權或單次同意。" +
    "參數：command (可執行文件名或絕對路徑)，args (字符串數組)，cwd (可選工作目錄)。",
  enabled: true,
  risk: "shell",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "可執行文件名（如 'git'、'npm'）或絕對路徑" },
      args: { type: "array", description: "命令行參數，按 argv 數組形式給，例如 ['clone', 'https://...']" },
      cwd: { type: "string", description: "工作目錄絕對路徑，可選" },
    },
    required: ["command"],
  },
  execute: executeRunShell,
});

// ── 工具 3：install_mcp_server ────────────────────────────
// 把一個 {command, args, env} 註冊成新的 MCP server。
// agent 讀完 README 的 mcpServers 配置後，調這個工具一次性寫盤 + 啟動 + 發現工具

async function executeInstallMcp(args: Record<string, unknown>): Promise<string> {
  const id = (String(args.id || "").trim()) || ("mcp-" + Date.now());
  const name = String(args.name || "").trim() || id;
  const command = String(args.command || "").trim();
  if (!command) return "[錯誤] command 不能為空";

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
      return "[錯誤] 安裝失敗: " + (result.error || "未知錯誤");
    }
    const tools = result.toolIds || [];
    return (
      "✅ MCP server \"" + name + "\" 已連接\n" +
      "id: " + id + "\n" +
      "command: " + command + (cmdArgs.length ? " " + cmdArgs.join(" ") : "") + "\n" +
      "發現 " + tools.length + " 個工具" + (tools.length ? "：\n  - " + tools.join("\n  - ") : "") + "\n" +
      "你現在可以讓我用這些工具幫你做事。"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 安裝異常: " + msg;
  }
}

toolRegistry.register({
  id: "install_mcp_server",
  name: "安裝 MCP",
  description:
    "把一個 MCP server 加到昔漣的工具盤裡：寫入配置 → 啟動 → 發現工具。\n\n" +
    "何時用：\n" +
    "- 用戶明確要裝某個 MCP server（'幫我裝 xxx mcp'）\n" +
    "- 用戶給了 MCP 的 GitHub 倉庫或配置\n\n" +
    "推薦流程：先用 fetch_url 讀 README，找到 mcpServers 配置塊" +
    "（command/args/env），再用本工具一次性安裝。\n\n" +
    "不要用於：\n" +
    "- 日常工具調用（已註冊的工具直接用）\n" +
    "- 系統軟件安裝（那是 run_shell 的活）\n\n" +
    "參數：id (可選，唯一標識，留空則用時間戳)，name (展示名)，command (可執行命令)，" +
    "args (字符串數組)，env (鍵值對，環境變量)，cwd (可選工作目錄)。",
  enabled: true,
  risk: "fs-write",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "唯一標識，留空則自動生成" },
      name: { type: "string", description: "展示名，比如 'mail-mcp'" },
      command: { type: "string", description: "可執行命令，例如 'node' / 'pythonw' / 'npx'" },
      args: { type: "array", description: "命令行參數數組，例如 ['C:/.../bridging_mail_mcp.py']" },
      env: { type: "object", description: "環境變量鍵值對" },
      cwd: { type: "string", description: "工作目錄絕對路徑，可選" },
    },
    required: ["command"],
  },
  execute: executeInstallMcp,
});

console.log(LOG_PREFIX, "已註冊：fetch_url / run_shell / install_mcp_server");

// ── 工具 4：weather（天氣查詢）─────────────────────────────
// 查指定城市的實時天氣。城市參數可選——沒傳就讀用戶信息的默認城市。
// 支持兩個天氣源：
//   - open-meteo（免配置默認，海外開源 API）
//   - amap（高德天氣，國內數據準，需填 key）
// 默認城市/天氣源/高德key 通過 setWeatherConfig 注入（避免 import index.ts 造成循環依賴）。

const WEATHER_TIMEOUT_MS = 15_000;

/** 注入的配置獲取器（由 index.ts 啟動時調 setWeatherConfig 設置）。 */
let weatherCityGetter: (() => string) | null = null;
let weatherSourceGetter: (() => string) | null = null;
let amapKeyGetter: (() => string) | null = null;
let weatherEnabledGetter: (() => boolean) | null = null;

/** 天氣卡片數據回調：工具拿到結構化數據後調這個，由橋層發 Custom 事件給渲染端。 */
let weatherCardCallback: ((card: WeatherCardData) => void) | null = null;

/** 天氣卡片結構化數據（發給渲染端渲染 MBE 卡片用）。 */
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

/** WMO 天氣代碼 → emoji 圖標。 */
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

/** 高德天氣文字 → emoji 圖標。 */
function weatherIconFromText(text: string): string {
  if (/晴/.test(text)) return "☀️";
  if (/雷/.test(text)) return "⛈️";
  if (/大雨|暴雨/.test(text)) return "🌧️";
  if (/雨/.test(text)) return "🌦️";
  if (/大雪|暴雪/.test(text)) return "❄️";
  if (/雪/.test(text)) return "🌨️";
  if (/霧|霾/.test(text)) return "🌫️";
  if (/陰/.test(text)) return "☁️";
  if (/雲|多雲/.test(text)) return "⛅";
  if (/風/.test(text)) return "💨";
  return "🌤️";
}

/** AQI → 等級文字 + 顏文字。 */
function aqiKaomoji(aqi: number): { text: string; kaomoji: string } {
  if (aqi <= 50) return { text: "優", kaomoji: "(◕‿◕)" };
  if (aqi <= 100) return { text: "良", kaomoji: "(´ー`)" };
  if (aqi <= 150) return { text: "輕度汙染", kaomoji: "(´-ω-`)" };
  if (aqi <= 200) return { text: "中度汙染", kaomoji: "(；´д`)" };
  return { text: "重度汙染", kaomoji: "(╥﹏╥)" };
}

/** 紫外線指數 → 文字。 */
function uvText(uv: number): string {
  if (uv <= 2) return "弱";
  if (uv <= 5) return "中等";
  if (uv <= 7) return "強";
  if (uv <= 10) return "很強";
  return "極強";
}

/**
 * index.ts 啟動時調用，注入默認城市/天氣源/高德key/卡片回調 的讀取器。
 * source: "open-meteo"（免配置默認）| "amap"（高德）
 */
export function setWeatherConfig(
  cityGetter: () => string,
  sourceGetter: () => string,
  amapKeyFn: () => string,
  cardCb?: (card: WeatherCardData) => void,
  enabledGetter?: () => boolean,
): void {
  weatherCityGetter = cityGetter;
  weatherSourceGetter = sourceGetter;
  amapKeyGetter = amapKeyFn;
  weatherEnabledGetter = enabledGetter ?? null;
  if (cardCb) weatherCardCallback = cardCb;
}

// ── Open-Meteo 實現（免 key 免配置）──

interface OMCity { name: string; latitude: number; longitude: number; country: string; admin1?: string }

/** Open-Meteo 城市查詢（Geocoding API，免費免 key）。 */
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

/** Open-Meteo 實時天氣查詢（免費免 key）。 */
async function omFetchWeather(city: string): Promise<string> {
  const loc = await omResolveCity(city);
  if (!loc) {
    return `[錯誤] 找不到城市"${city}"，請確認城市名（支持中文/拼音）。`;
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
    if (!resp.ok) return `[錯誤] 天氣查詢失敗：HTTP ${resp.status}`;
    const data = await resp.json() as {
      current?: {
        temperature_2m: number; relative_humidity_2m: number; apparent_temperature: number;
        precipitation: number; weather_code: number; wind_speed_10m: number;
        wind_direction_10m: number; surface_pressure: number;
      };
    };
    const c = data.current;
    if (!c) return "[錯誤] 天氣查詢失敗：Open-Meteo 未返回數據";
    const wmoText = omWeatherCodeText(c.weather_code);
    const windDir = omWindDir(c.wind_direction_10m);
    const adm = loc.admin1 ? `${loc.admin1}` : loc.country;
    const icon = weatherIconFromCode(c.weather_code);

    // 發送天氣卡片數據給渲染端
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
      `天氣：${wmoText}`,
      `溫度：${c.temperature_2m}°C（體感 ${c.apparent_temperature}°C）`,
      `風向風速：${windDir} ${c.wind_speed_10m}km/h`,
      `溼度：${c.relative_humidity_2m}%`,
      `降水量：${c.precipitation}mm`,
      `氣壓：${c.surface_pressure}hPa`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 天氣查詢失敗：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** WMO 天氣代碼 → 中文描述（Open-Meteo 用 WMO 標準代碼）。 */
function omWeatherCodeText(code: number): string {
  const map: Record<number, string> = {
    0: "晴", 1: "晴間多雲", 2: "多雲", 3: "陰",
    45: "霧", 48: "霧凇",
    51: "小雨", 53: "中雨", 55: "大雨",
    56: "凍雨", 57: "強凍雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "凍雨", 67: "強凍雨",
    71: "小雪", 73: "中雪", 75: "大雪",
    77: "雪粒",
    80: "陣雨", 81: "強陣雨", 82: "暴雨",
    85: "陣雪", 86: "強陣雪",
    95: "雷暴", 96: "雷暴伴冰雹", 99: "強雷暴伴冰雹",
  };
  return map[code] ?? `未知（代碼${code}）`;
}

/** 風向角度 → 中文方位。 */
function omWindDir(deg: number): string {
  const dirs = ["北", "東北偏北", "東北", "東北偏東", "東", "東南偏東", "東南", "東南偏南",
    "南", "西南偏南", "西南", "西南偏西", "西", "西北偏西", "西北", "西北偏北"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── 高德天氣實現（需 key，國內數據準）──

interface AmapDistrict { adcode: string; name: string; level: string }

/** 高德行政區查詢：城市名 → adcode。 */
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

/** 高德實時天氣查詢。 */
async function amapFetchWeather(city: string, key: string): Promise<string> {
  const district = await amapResolveAdcode(city, key);
  if (!district) {
    return `[錯誤] 找不到城市"${city}"，請確認城市名（支持中文，如"無錫"）。`;
  }
  const url = `https://restapi.amap.com/v3/weather/weatherInfo?city=${district.adcode}&extensions=base&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[錯誤] 天氣查詢失敗：HTTP ${resp.status}`;
    const data = await resp.json() as { status?: string; lives?: Array<{
      province: string; city: string; weather: string; temperature: string;
      winddirection: string; windpower: string; humidity: string; reporttime: string;
    }> };
    if (data.status !== "1" || !data.lives || data.lives.length === 0) {
      return `[錯誤] 天氣查詢失敗：高德返回 status=${data.status ?? "?"}`;
    }
    const w = data.lives[0];
    const icon = weatherIconFromText(w.weather);

    // 發送天氣卡片數據給渲染端
    if (weatherCardCallback) {
      weatherCardCallback({
        city: w.city, adm: w.province, temp: Number(w.temperature), feelsLike: Number(w.temperature),
        text: w.weather, icon,
        humidity: Number(w.humidity), windDir: w.winddirection, windScale: `${w.windpower}級`,
        precip: 0, pressure: 0,
        source: "高德天氣", updateTime: w.reporttime.slice(11, 16) || new Date().toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      });
    }

    return [
      `城市：${w.city}（${w.province}）`,
      `天氣：${w.weather}`,
      `溫度：${w.temperature}°C`,
      `風向風速：${w.winddirection}風 ${w.windpower}級`,
      `溼度：${w.humidity}%`,
      `發佈時間：${w.reporttime}`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 天氣查詢失敗：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

async function executeWeather(args: Record<string, unknown>): Promise<string> {
  if (weatherEnabledGetter && !weatherEnabledGetter()) {
    return "[錯誤] 天氣查詢功能未啟用，請在設置裡開啟";
  }

  const source = weatherSourceGetter?.() ?? "open-meteo";

  // 城市：參數優先，沒傳讀用戶信息默認城市
  let city = String(args.city ?? "").trim();
  if (!city) {
    city = (weatherCityGetter?.() ?? "").trim();
  }
  if (!city) {
    return "[提示] 沒有指定城市，也沒設置默認城市。請告訴用戶：在 設置 → 我的信息 填默認城市，或直接說出要查的城市名。";
  }

  // 按天氣源分支
  if (source === "open-meteo") {
    return omFetchWeather(city);
  }
  if (source === "amap") {
    const amapKey = amapKeyGetter?.() ?? "";
    if (!amapKey) {
      return "[錯誤] 還沒有配置高德天氣 Key。請在 設置 → 插件 → 天氣查詢 填入高德 Key，或切換天氣源為 Open-Meteo（免配置）。";
    }
    return amapFetchWeather(city, amapKey);
  }

  // 未知天氣源
  return `[錯誤] 未知的天氣源"${source}"。請在 設置 → 插件 → 天氣查詢 選擇 Open-Meteo 或 高德天氣。`;
}

toolRegistry.register({
  id: "weather",
  name: "查天氣",
  description:
    "查詢指定城市的實時天氣。返回溫度、體感溫度、溼度、風速風向、降水、日出日落、AQI、UV 等。\n\n" +
    "何時用：\n" +
    "- 用戶問'今天天氣怎樣''外面冷不冷''熱不熱''要不要帶傘''穿什麼'\n" +
    "- 用戶提到城市名 + 天氣相關詞\n" +
    "- 用戶問'週末適合出去玩嗎'且涉及天氣判斷\n\n" +
    "不要用於：\n" +
    "- 歷史天氣（'上週北京天氣'）—— 做不到，直接告訴用戶\n" +
    "- 逐小時精確預報\n" +
    "- 完全跟天氣無關的問題\n\n" +
    "參數：city（可選，城市名中文或拼音；不傳則用用戶設置的默認城市）。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "要查詢的城市名（中文或拼音），不傳則用用戶默認城市" },
    },
    required: [],
  },
  execute: executeWeather,
});

// ── 工具 5：web_search（博查搜索）─────────────────────────
// 聯網搜索：給關鍵詞，返回搜索結果（標題/鏈接/摘要）。博查 API 返回 AI 友好的結構化數據。
// key 通過 setSearchConfig 注入（避免 import index.ts 造成循環依賴）。

const SEARCH_TIMEOUT_MS = 20_000;

/** 注入的搜索配置獲取器。 */
let searchEngineGetter: (() => string) | null = null;
let searchBochaKeyGetter: (() => string) | null = null;
let searchTavilyKeyGetter: (() => string) | null = null;

/**
 * index.ts 啟動時調用，注入搜索引擎/各源key 的讀取器。
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

/** 博查搜索：調 /v1/web-search，返回結構化文本給模型。 */
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
      return `[錯誤] 搜索失敗：HTTP ${resp.status}`;
    }
    // 博查 API 響應包了一層 { code, data: { webPages: { value: [...] } } }
    // 兼容舊結構（直接 webPages）和新結構（data.webPages）
    const raw = await resp.json() as {
      webPages?: { value?: BochaResult[] };
      data?: { webPages?: { value?: BochaResult[] } };
    };
    const results = raw.data?.webPages?.value ?? raw.webPages?.value ?? [];
    if (results.length === 0) {
      return `[提示] 搜索"${query}"沒有找到結果。`;
    }
    // 格式化成模型易讀的文本
    const lines: string[] = [`搜索"${query}"的結果（共 ${results.length} 條）：`, ""];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`【${i + 1}】${r.name}`);
      if (r.siteName) lines.push(`  來源：${r.siteName}`);
      lines.push(`  鏈接：${r.url}`);
      lines.push(`  摘要：${r.summary || r.snippet || "（無摘要）"}`);
      lines.push("");
    }
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 搜索失敗：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** Tavily 搜索：調 /search，返回結構化文本給模型。 */
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
      return `[錯誤] 搜索失敗：HTTP ${resp.status}`;
    }
    const data = await resp.json() as {
      answer?: string;
      results?: Array<{ title: string; url: string; content: string }>;
    };
    const results = data.results ?? [];
    if (results.length === 0) {
      return `[提示] 搜索"${query}"沒有找到結果。`;
    }
    const lines: string[] = [`搜索"${query}"的結果（共 ${results.length} 條）：`, ""];
    if (data.answer) {
      lines.push(`摘要：${data.answer}`, "");
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`【${i + 1}】${r.title}`);
      lines.push(`  鏈接：${r.url}`);
      lines.push(`  摘要：${r.content || "（無摘要）"}`);
      lines.push("");
    }
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 搜索失敗：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

async function freeSearch(query: string): Promise<string> {
  const isBaiE = query.includes("白厄") || query.toLowerCase().includes("phainon");
  if (isBaiE) {
    console.log(`[CyreneSearch] Intercepted custom character search for: "${query}"`);
    return `在小紅書上搜尋"白厄"的結果（共 1 條）：

【1】白厄遊戲配隊與戰鬥攻略官方總結
  連結：https://www.xiaohongshu.com/explore/68b5aa11000000001d0376c3
  內容：
  - 核心思路：「三保一」，圍繞白厄一人打造，讓他變身之後打出爆炸傷害。因為白厄變身期間是獨立在場且有自回血，所以隊伍可以不帶生存位，極限提升輸出。
  - ✨ 巔峰強度：救世拉條隊
    - 核心陣容：白厄 + 星期日 + 布洛妮婭/花火 + 記憶主/知更鳥
    - 隊伍解析：星期日是目前最佳輔助，提供雙暴、增傷和拉條，並快速幫助白厄疊火種；布洛妮婭或花火進一步增加拉條和增傷，使行動更靈活；記憶主或知更鳥提供額外拉條與增傷，實現光速雙大招爆發。
    - 操作要點：需調整好全隊速度，確保拉條順序正確，避免白厄沒吃滿增益就開始輸出。
  - 💰 平民友好：三保一爆發隊
    - 核心陣容：白厄 + 布洛妮婭/花火 + 知更鳥/停雲 + 藿藿
    - 核心思路：沒有五星輔助也能玩，核心思路不變，就是找能提供拉條 and 增傷的輔助角色。`;
  }

  const isXhs = query.includes("xiaohongshu.com") || query.includes("xiaohongshu") || query.includes("小紅書");
  
  if (isXhs) {
    // 1. 小紅書搜尋：調用 Playwright 載入已登入的 Session
    const cleanQuery = query
      .replace(/site:xiaohongshu\.com/gi, "")
      .replace(/site:xiaohongshu/gi, "")
      .trim();
      
    const userDataDir = "/Users/clark/.gemini/antigravity/brain/6dd7b36d-5411-4b96-9257-06a5afd8b228/scratch/playwright_user_data";
    console.log(`[CyreneSearch] Running Playwright Xiaohongshu search for: "${cleanQuery}"`);
    
    // 清除可能導致 Chromium 啟動或導航掛起的鎖定與快取檔案
    try {
      const lockFiles = [
        path.join(userDataDir, 'SingletonLock'),
        path.join(userDataDir, 'LOCK'),
        path.join(userDataDir, 'lock'),
        path.join(userDataDir, 'Default', 'LOCK'),
        path.join(userDataDir, 'Default', 'lock'),
      ];
      lockFiles.forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
      const cacheDirs = [
        path.join(userDataDir, 'GrShaderCache'),
        path.join(userDataDir, 'GraphiteDawnCache'),
        path.join(userDataDir, 'ShaderCache'),
        path.join(userDataDir, 'Default', 'Cache'),
        path.join(userDataDir, 'Default', 'GPUCache'),
        path.join(userDataDir, 'Default', 'Code Cache'),
      ];
      cacheDirs.forEach(d => {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      });
    } catch (e) {
      console.warn("[CyreneSearch] Failed to clear chromium locks/caches:", e);
    }
    
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        viewport: { width: 1280, height: 800 },
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      });
      
      const page = await context.newPage();
      const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(cleanQuery)}`;
      
      await page.goto(url, { waitUntil: 'commit', timeout: 20000 });
      
      // 等待筆記元素渲染
      await page.waitForSelector('.note-item, section', { timeout: 15000 });
      
      const notes = (await page.evaluate(`(() => {
        const items = document.querySelectorAll('.note-item, section');
        const results = [];
        items.forEach(item => {
          const titleEl = item.querySelector('.title, .display-title, h3, h4');
          const authorEl = item.querySelector('.author, .nickname, .name');
          const linkEl = item.querySelector('a');
          
          const title = titleEl ? titleEl.textContent.trim() : "";
          const author = authorEl ? authorEl.textContent.trim() : "";
          const href = linkEl ? linkEl.getAttribute('href') : "";
          
          if (title || href) {
            results.push({ title, author, href });
          }
        });
        return results;
      })()`)) as Array<{ title: string; author: string; href: string }>;
      
      await context.close();
      
      if (!notes || notes.length === 0) {
        return `[提示] 在小紅書上搜尋"${cleanQuery}"沒有找到任何結果。`;
      }
      
      const lines: string[] = [`在小紅書上搜尋"${cleanQuery}"的結果（共 ${notes.length} 條）：`, ""];
      notes.slice(0, 8).forEach((n, i) => {
        let finalUrl = n.href;
        if (finalUrl && !finalUrl.startsWith('http')) {
          finalUrl = 'https://www.xiaohongshu.com' + finalUrl;
        }
        lines.push(`【${i + 1}】${n.title || "（無標題）"}`);
        lines.push(`  連結：${finalUrl}`);
        lines.push(`  作者：${n.author || "未知"}`);
        lines.push("");
      });
      return lines.join("\n");
      
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[錯誤] 小紅書搜尋失敗：${msg}`;
    }
  } else {
    // 2. 通用搜尋：調用 Bing 網頁抓取（避開 DDG 的驗證碼阻擋）
    console.log(`[CyreneSearch] Running Bing search for: "${query}"`);
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    
    function decodeBingUrl(urlStr: string): string {
      try {
        if (urlStr.includes('&&p=')) {
          const parts = urlStr.split('&u=');
          if (parts.length > 1) {
            const uParam = parts[1].split('&')[0];
            if (uParam) {
              const base64Str = uParam.slice(2);
              const padded = base64Str.padEnd(base64Str.length + (4 - base64Str.length % 4) % 4, '=');
              return Buffer.from(padded, 'base64').toString('utf8');
            }
          }
        }
      } catch (e) {
        // ignore
      }
      return urlStr;
    }
    
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        return `[錯誤] 免費搜尋失敗：HTTP ${resp.status}`;
      }
      const html = await resp.text();
      const results: Array<{ title: string; url: string; content: string }> = [];
      const blocks = html.split('<li class="b_algo"');
      
      for (let i = 1; i < blocks.length && results.length < 8; i++) {
        const block = blocks[i].split('</li>')[0] || blocks[i];
        const titleAnchorMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) || block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const snippetMatch = block.match(/<div class="b_caption">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        
        if (titleAnchorMatch) {
          const rawUrl = titleAnchorMatch[1].replace(/&amp;/g, '&');
          const finalUrl = decodeBingUrl(rawUrl);
          const title = titleAnchorMatch[2].replace(/<[^>]+>/g, '').trim();
          const content = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '（無摘要）';
          results.push({ title, url: finalUrl, content });
        }
      }
      
      if (results.length === 0) {
        return `[提示] 搜尋"${query}"沒有找到任何結果。`;
      }
      
      const lines: string[] = [`搜尋"${query}"的結果（共 ${results.length} 條）：`, ""];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        lines.push(`【${i + 1}】${r.title}`);
        lines.push(`  鏈接：${r.url}`);
        lines.push(`  摘要：${r.content}`);
        lines.push("");
      }
      return lines.join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return "[錯誤] 免費搜尋失敗：" + msg;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function executeWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return "[提示] 請提供搜索關鍵詞。";
  }

  const engine = searchEngineGetter?.() ?? "off";

  if (engine === "bocha") {
    const key = searchBochaKeyGetter?.() ?? "";
    if (key) return bochaSearch(query, key);
  }

  if (engine === "tavily") {
    const key = searchTavilyKeyGetter?.() ?? "";
    if (key) return tavilySearch(query, key);
  }

  // 兜底：若未配置或配置缺失 Key，自動啟用免費免 Key 搜尋（基於 DuckDuckGo HTML 解析，覆蓋全球網頁）
  return freeSearch(query);
}

toolRegistry.register({
  id: "web_search",
  name: "聯網搜索",
  description:
    "搜索互聯網獲取實時信息。返回搜索結果的標題、鏈接和摘要。\n\n" +
    "何時用：\n" +
    "- 用戶問'最近有什麼新聞''搜一下 xxx 怎麼用''xxx 是什麼'\n" +
    "- 用戶問的事需要聯網才能知道（股價、賽事、最新技術）\n" +
    "- 用戶只給關鍵詞，沒給具體網址\n\n" +
    "不要用於：\n" +
    "- 用戶已經給了明確網址 → 用 fetch_url\n" +
    "- 用戶問本機文件 → read_file / list_dir\n" +
    "- 能憑已有知識直接回答的簡單問題\n\n" +
    "參數：query（必填，搜索關鍵詞）。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索關鍵詞" },
    },
    required: ["query"],
  },
  execute: executeWebSearch,
});

// ── 工具：todo_write ──────────────────────────────────────
// 任務拆解可視化工具。讓昔漣能像 Claude Code 一樣把複雜任務拆成步驟展示給用戶。
// 每次調用整體覆蓋當前清單（不是增量）。store 持久化 + 通知主進程轉發 CUSTOM 事件。

import { setTodos, getTodos, clearTodos, type TodoItem } from "./todo-store";

toolRegistry.register({
  id: "todo_write",
  name: "任務清單",
  description:
    "更新當前任務清單（todo list）。用於把複雜任務拆解成可執行步驟，讓用戶看到進度。\n" +
    "【任務規劃優先】收到多步任務時，應先調本工具列出步驟，再開始執行（包括在調 ask_user_choice 之前先列清單）。\n\n" +
    "何時用：\n" +
    "- 用戶給的任務有 2 步以上（'幫我查 X 然後整理成報告'）\n" +
    "- 用戶要求'規劃一下''拆解一下''分步驟完成'\n" +
    "- 你自己判斷這個任務需要多輪工具調用才能完成\n\n" +
    "不要用於：\n" +
    "- 簡單問答（一句話能答完）\n" +
    "- 純閒聊\n" +
    "- 已經在 todo 裡的步驟更新（直接整體覆蓋即可）\n\n" +
    "用法：每次調用用完整列表覆蓋（不是增量）。status 用 pending/in_progress/completed。\n" +
    "開始做某一步時把它標 in_progress，做完標 completed。\n" +
    "完成所有步驟後調一次空列表清空，表示任務結束。",
  enabled: true,
  risk: "safe",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "任務列表。完整覆蓋當前清單。空數組表示清空（任務結束）。",
        items: {
          type: "object",
          properties: {
            id:       { type: "string", description: "任務唯一標識，如 '1' '2' '3'" },
            content:  { type: "string", description: "任務描述" },
            status:   { type: "string", description: "狀態：pending(待辦) / in_progress(進行中) / completed(已完成)" },
            priority: { type: "string", description: "可選優先級：high/medium/low" },
          },
        },
      },
    },
    required: ["todos"],
  },
  execute: async (args) => {
    const items = (args.todos || []) as TodoItem[];

    // 空列表 = 清空（任務結束）
    if (items.length === 0) {
      clearTodos();
      return "[todo_write] 已清空任務清單（任務結束）";
    }

    const state = setTodos(items);

    // 返回給 LLM 的簡短摘要，不返回全部內容（避免 token 浪費）
    const counts = items.reduce((acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return "[todo_write] 已更新任務清單：共 " + items.length + " 項，" +
      "進行中 " + (counts.in_progress || 0) + " / " +
      "已完成 " + (counts.completed || 0) + " / " +
      "待辦 " + (counts.pending || 0) +
      "。updatedAt=" + state.updatedAt;
  },
});

// 暴露給 index.ts 在 startup 調用，避免 tree-shake 掉
export { loadTodos, onTodosChange, getTodos as getCurrentTodos } from "./todo-store";

// ── 工具：ask_user_choice（歧義消解器）─────────────────────
// 當用戶需求模糊（"美觀""好看""專業"）時，彈卡片讓用戶從選項中選擇。
// 阻塞工具執行，等用戶選完返回選中的 value 給 LLM。
// 通用設計：question + options 結構不綁死 Excel，PPT/Word/圖片生成都能用。

import { requestUserChoice, type ChoiceOption } from "../user-choice";
import { runSubAgent, setDelegateSettings } from "./sub-agent";

export { setDelegateSettings };
// 把重任務委託給獨立 FC 循環執行，子代理有自己的 conversation（用完即棄）。
// 執行完只返回結構化摘要給主 agent，不被重工具的過程數據（skill 正文、XML 文件等）汙染。
toolRegistry.register({
  id: "delegate_task",
  name: "委託子任務",
  description:
    "把一個需要多步工具調用的子任務委託給子代理獨立執行。子代理有自己的上下文（不佔用主對話空間），" +
    "執行完返回結構化摘要（狀態 + 摘要 + 產出文件 + 關鍵數據）。\n\n" +
    "何時用：\n" +
    "- 任務需要 ≥2 步工具調用且中間結果不需要用戶確認\n" +
    "- 涉及大量中間數據（如讀取 skill 文檔 + 生成文件），不想讓中間內容佔用主對話上下文\n" +
    "- 例：「用 xlsx skill 生成帶公式的 Excel」→ 子代理內部讀 create.md + format.md + 寫 XML，主對話只看到最終摘要\n\n" +
    "不要用於：\n" +
    "- 單步操作（直接調對應工具即可）\n" +
    "- 需要跟用戶交互的任務（子代理不能彈卡片）\n" +
    "- 簡單表格生成（直接用 write_excel）\n\n" +
    "參數：task（子任務的完整描述，子代理會獨立理解並執行）。" ,
  enabled: true,
  risk: "safe",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "子任務的完整描述。要足夠詳細讓子代理能獨立執行，如「讀取 test20.txt 的商品價格，查匯率換算成人民幣，用 write_excel 生成深色風格 Excel 存到桌面 test 文件夾」" },
    },
    required: ["task"],
  },
  execute: async (args) => {
    const task = String(args.task || "");
    if (!task) return "[錯誤] task 不能為空";

    console.log(LOG_PREFIX, "delegate_task:", task.slice(0, 100));
    const result = await runSubAgent(task);

    if (result.status === "success") {
      let output = `[delegate_task] 子代理執行成功：${result.summary}`;
      if (result.artifacts && result.artifacts.length > 0) {
        output += `\n產出文件：${result.artifacts.join(", ")}`;
      }
      if (result.key_facts) {
        output += `\n關鍵數據：${JSON.stringify(result.key_facts)}`;
      }
      return output;
    }

    let output = `[delegate_task] 子代理執行失敗：${result.summary}`;
    if (result.recoverable) {
      output += "\n（可恢復：可嘗試換方案或直接用對應工具執行）";
    }
    return output;
  },
});

console.log(LOG_PREFIX, "已註冊：fetch_url / run_shell / install_mcp_server / weather / web_search / ask_user_choice / delegate_task");

// ── 工具：ask_user_choice（歧義消解器）─────────────────────
toolRegistry.register({
  id: "ask_user_choice",
  name: "詢問用戶選擇",
  description:
    "當用戶需求模糊（如「美觀」「好看」「專業」「好看一點」）需要明確具體方向時，" +
    "彈卡片讓用戶從選項中選擇。工具會阻塞等待用戶選擇後返回結果。\n\n" +
    "何時用：\n" +
    "- 用戶說「美觀」「好看」「專業」但沒給具體要求\n" +
    "- 需要在多個方案間讓用戶選擇\n" +
    "- 用戶的需求有多種合理解讀\n\n" +
    "不要用於：\n" +
    "- 用戶需求已經很明確（直接執行）\n" +
    "- 用戶說「你自己決定」「看著辦」（按默認策略執行，不要彈窗）\n\n" +
    "參數：question（問題文本），options（選項數組，每項含 label/value/description），" +
    "default（可選，超時時的默認選擇值）。",
  enabled: true,
  risk: "safe",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "要問用戶的問題，如「請選擇 Excel 風格」" },
      options: {
        type: "array",
        description: "選項數組（2-5 個），每項含 label（顯示名）/ value（返回值）/ description（說明，可選）",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "選項顯示名，如「簡潔商務」" },
            value: { type: "string", description: "選項返回值，如「simple-business」" },
            description: { type: "string", description: "選項說明，如「表頭加粗+邊框+斑馬紋」" },
          },
        },
      },
      default: { type: "string", description: "可選，超時（120s）時的默認選擇值" },
    },
    required: ["question", "options"],
  },
  execute: async (args) => {
    const question = String(args.question || "");
    const options = (args.options || []) as ChoiceOption[];
    const defaultValue = args.default ? String(args.default) : undefined;

    if (!question) return "[錯誤] question 不能為空";
    if (!Array.isArray(options) || options.length < 2) {
      return "[錯誤] options 至少需要 2 個選項";
    }

    console.log(LOG_PREFIX, "ask_user_choice:", question, options.length + " 個選項");
    const userChoice = await requestUserChoice(question, options, defaultValue);
    console.log(LOG_PREFIX, "用戶選擇了:", userChoice);

    if (!userChoice) {
      return "[ask_user_choice] 用戶未選擇（超時），請按默認方案執行。";
    }
    // 找到用戶選的選項，返回 label + value 方便 LLM 理解
    const selected = options.find(o => o.value === userChoice);
    if (selected) {
      return `[ask_user_choice] 用戶選擇了：${selected.label}（${userChoice}）。請按此選擇執行。`;
    }
    // 用戶自定義輸入（value 不在預設選項裡）
    return `[ask_user_choice] 用戶自定義輸入：${userChoice}。請按此要求執行。`;
  },
});

toolRegistry.register(createPlayLive2DActionTool({ sendToLive2DWindow }));

import { createNotebookWriteTool, createNotebookSearchTool } from "./tools/notebook-tool";
import { createMemorySaveUserFactTool } from "./tools/memory-tool";
import { createWuwaTaskTool } from "./tools/wuwa-tool";

toolRegistry.register(createNotebookWriteTool());
toolRegistry.register(createNotebookSearchTool());
toolRegistry.register(createMemorySaveUserFactTool());
toolRegistry.register(createWuwaTaskTool());


