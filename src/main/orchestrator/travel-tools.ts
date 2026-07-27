// 🚗 出行工具 —— 路線規劃（駕車/步行/騎行/公交）。
//
// 設計原則：
// - 複用 GeneralSettings 中已有的 amapKey（高德 Web 服務 API Key）
// - 用高德地理編碼將地名轉座標，再調用路徑規劃 API
// - 返回易讀的中文路線描述
// - 不引入新依賴，複用全局 fetch

import { toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[TravelTools]";
const TRAVEL_TIMEOUT_MS = 15000;

// ══════════════════════════════════════════════════════════
// 配置注入
// ══════════════════════════════════════════════════════════

let amapKeyGetter: (() => string) | null = null;
let travelEnabledGetter: (() => boolean) | null = null;

/** index.ts 啟動時注入 amapKey 獲取器。 */
export function setTravelConfig(amapKeyFn: () => string, enabledFn?: () => boolean): void {
  amapKeyGetter = amapKeyFn;
  travelEnabledGetter = enabledFn ?? null;
}

// ══════════════════════════════════════════════════════════
// 高德地理編碼：地名 → "經度,緯度"
// ══════════════════════════════════════════════════════════

async function geocode(address: string, key: string): Promise<string | null> {
  const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(address)}&output=JSON&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = await resp.json() as { status?: string; geocodes?: Array<{ location: string }> };
    if (data.status !== "1" || !data.geocodes || data.geocodes.length === 0) return null;
    return data.geocodes[0].location; // 格式 "116.397428,39.90923"
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════════════
// 各出行方式 API 封裝
// ══════════════════════════════════════════════════════════

/** 駕車路徑規劃。 */
async function planDriving(origin: string, destination: string, key: string): Promise<string> {
  const url = `https://restapi.amap.com/v3/direction/driving?origin=${origin}&destination=${destination}&extensions=base&strategy=0&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[錯誤] 駕車路線查詢失敗：HTTP ${resp.status}`;
    const data = await resp.json() as {
      route?: { paths?: Array<{ distance: string; duration: string; tolls: string; toll_distance: string; traffic_lights: string }> };
    };
    if (!data.route?.paths?.length) return "[錯誤] 未找到駕車路線";
    const path = data.route.paths[0];
    const distKm = (Number(path.distance) / 1000).toFixed(1);
    const durMin = Math.round(Number(path.duration) / 60);
    const toll = Number(path.tolls);
    const lines = [
      `🚗 駕車路線`,
      `距離：${distKm} 公里`,
      `預計用時：${durMin} 分鐘`,
      toll > 0 ? `路費：${toll.toFixed(0)} 元` : `路費：免費`,
      `紅綠燈：${path.traffic_lights || 0} 個`,
    ];
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 駕車路線查詢失敗：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** 步行路徑規劃（最長 100km）。 */
async function planWalking(origin: string, destination: string, key: string): Promise<string> {
  const url = `https://restapi.amap.com/v3/direction/walking?origin=${origin}&destination=${destination}&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[錯誤] 步行路線查詢失敗：HTTP ${resp.status}`;
    const data = await resp.json() as {
      route?: { paths?: Array<{ distance: string; duration: string }> };
    };
    if (!data.route?.paths?.length) return "[錯誤] 未找到步行路線";
    const path = data.route.paths[0];
    const distM = Number(path.distance);
    const durMin = Math.round(Number(path.duration) / 60);
    const distStr = distM >= 1000 ? `${(distM / 1000).toFixed(1)} 公里` : `${distM.toFixed(0)} 米`;
    return [
      `🚶 步行路線`,
      `距離：${distStr}`,
      `預計用時：${durMin} 分鐘`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 步行路線查詢失敗：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** 騎行路徑規劃（最長 500km）。 */
async function planCycling(origin: string, destination: string, key: string): Promise<string> {
  const url = `https://restapi.amap.com/v4/direction/bicycling?origin=${origin}&destination=${destination}&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[錯誤] 騎行路線查詢失敗：HTTP ${resp.status}`;
    const data = await resp.json() as {
      data?: { paths?: Array<{ distance: string; duration: string }> };
    };
    if (!data.data?.paths?.length) return "[錯誤] 未找到騎行路線";
    const path = data.data.paths[0];
    const distKm = (Number(path.distance) / 1000).toFixed(1);
    const durMin = Math.round(Number(path.duration) / 60);
    return [
      `🚲 騎行路線`,
      `距離：${distKm} 公里`,
      `預計用時：${durMin} 分鐘`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 騎行路線查詢失敗：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** 公交路徑規劃（支持公交/地鐵/火車綜合換乘）。 */
async function planTransit(
  origin: string,
  destination: string,
  city: string,
  key: string,
): Promise<string> {
  const url = `https://restapi.amap.com/v3/direction/transit/integrated?origin=${origin}&destination=${destination}&city=${encodeURIComponent(city)}&strategy=0&extensions=base&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[錯誤] 公交路線查詢失敗：HTTP ${resp.status}`;
    const data = await resp.json() as {
      route?: { transits?: Array<{
        cost: string; duration: string; walking_distance: string;
        segments?: Array<{
          walking?: { distance: string; duration: string };
          bus?: { buslines?: Array<{ name: string; depart_stop: { name: string }; arrival_stop: { name: string } }> };
        }>;
      }>; taxi_cost?: string };
    };
    if (!data.route?.transits?.length) return "[錯誤] 未找到公交路線";
    const transit = data.route.transits[0];
    const durMin = Math.round(Number(transit.duration) / 60);
    const price = Number(transit.cost).toFixed(0);
    const walkDist = Number(transit.walking_distance);
    const walkStr = walkDist > 0 ? `（步行 ${walkDist.toFixed(0)} 米）` : "";

    // 提取換乘方案簡述
    const steps = transit.segments?.map((seg, i) => {
      if (seg.bus?.buslines?.length) {
        const bus = seg.bus.buslines[0];
        return `  ${i + 1}. 乘 ${bus.name}：${bus.depart_stop.name} → ${bus.arrival_stop.name}`;
      }
      if (seg.walking) {
        return `  ${i + 1}. 步行 ${Number(seg.walking.distance).toFixed(0)} 米`;
      }
      return "";
    }).filter(Boolean) || [];

    const lines = [
      `🚌 公交路線`,
      `預計用時：${durMin} 分鐘`,
      `票價：${price} 元${walkStr}`,
      data.route.taxi_cost ? `打車參考價：${data.route.taxi_cost} 元` : "",
      ...(steps.length ? [`換乘方案：`, ...steps] : []),
    ].filter(Boolean);

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 公交路線查詢失敗：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════════════
// 工具入口
// ══════════════════════════════════════════════════════════

async function executePlanTrip(args: Record<string, unknown>): Promise<string> {
  if (travelEnabledGetter && !travelEnabledGetter()) {
    return "[錯誤] 出行工具未啟用，請在設置裡開啟";
  }

  const amapKey = amapKeyGetter?.() ?? "";
  if (!amapKey) {
    return "[提示] 高德 API Key 未配置。可在 設置→插件 中找到 🚗出行工具，填入高德 Web 服務 API Key（註冊地址：https://lbs.amap.com）。";
  }

  const origin = String(args.origin ?? "").trim();
  const destination = String(args.destination ?? "").trim();
  if (!origin || !destination) {
    return "[錯誤] 請提供起點和終點";
  }

  const mode = String(args.mode ?? "駕車").trim();

  // 地理編碼：地名 → 座標
  const [origLoc, destLoc] = await Promise.all([
    geocode(origin, amapKey),
    geocode(destination, amapKey),
  ]);
  if (!origLoc) return `[錯誤] 無法解析起點「${origin}」的位置，請嘗試更具體的名稱`;
  if (!destLoc) return `[錯誤] 無法解析終點「${destination}」的位置，請嘗試更具體的名稱`;

  console.log(LOG_PREFIX, `規劃路線：「${origin}」→「${destination}」, 方式=${mode}`);

  switch (mode) {
    case "駕車":
    case "開車":
      return planDriving(origLoc, destLoc, amapKey);

    case "步行":
    case "走路":
      return planWalking(origLoc, destLoc, amapKey);

    case "騎行":
    case "騎車":
    case "自行車":
      return planCycling(origLoc, destLoc, amapKey);

    case "公交":
    case "公共交通":
    case "地鐵":
    case "公交地鐵": {
      const city = String(args.city ?? "").trim();
      if (!city) return "[錯誤] 公交路線必須提供城市（參數 city），例如 city='北京'";
      return planTransit(origLoc, destLoc, city, amapKey);
    }

    default:
      return `[錯誤] 不支持的出行方式「${mode}」。支持：駕車、步行、騎行、公交`;
  }
}

// ══════════════════════════════════════════════════════════
// 註冊
// ══════════════════════════════════════════════════════════

/** 註冊出行工具。index.ts startup 調一次。 */
export function registerTravelTools(): void {
  toolRegistry.register({
    id: "plan_trip",
    name: "🚗出行工具",
    description:
      "路線規劃，查駕車/步行/騎行/公交的路線、距離和預計時間。\n\n" +
      "何時用：\n" +
      "- 用戶問「從 A 到 B 怎麼走」「去 X 怎麼坐車」「到 Y 多遠」\n" +
      "- 用戶想知道駕車/公交/騎行/步行的路線和耗時\n" +
      "- 用戶問「打車要多少錢」「騎自行車去 X 多久」\n\n" +
      "不要用於：\n" +
      "- 查天氣（用 weather 工具）\n" +
      "- 查具體公交線路信息或時刻表（不支持）\n" +
      "- 查路況（不支持）\n\n" +
      "參數：\n" +
      "- origin（必填）：起點，如「故宮」「北京市天安門」\n" +
      "- destination（必填）：終點\n" +
      "- mode（可選，默認駕車）：出行方式——駕車/開車、步行/走路、騎行/騎車/自行車、公交/公共交通/地鐵\n" +
      "- city（公交必填）：城市名，如「北京」「上海」。僅公交模式需要",
    enabled: true,
    risk: "network",
    inputSchema: {
      type: "object",
      properties: {
        origin:       { type: "string", description: "起點，如「故宮」「北京市天安門」" },
        destination:  { type: "string", description: "終點" },
        mode:         { type: "string", description: "出行方式：駕車/開車、步行/走路、騎行/騎車/自行車、公交/公共交通/地鐵（默認駕車）" },
        city:         { type: "string", description: "城市名，如「北京」「上海」，公交模式必填" },
      },
      required: ["origin", "destination"],
    },
    execute: executePlanTrip,
  });

  console.log(LOG_PREFIX, "已註冊：plan_trip（🚗出行工具）");
}
