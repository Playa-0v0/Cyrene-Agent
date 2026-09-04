/**
 * weather-tool 示例：联网 + 工具 + 普通存储 + Secrets。
 *
 * 展示三个知识点：
 * 1. deps 声明 secrets，通过 ctx.deps.secrets 读取插件命名空间内的密钥
 * 2. 网络请求降级：有 OpenWeather 密钥走官方接口，没有或失败时走免密钥的 Open-Meteo
 * 3. ctx.storage 记住上次查询的城市，作为下次省略参数时的默认值
 */
import type { CyrenePlugin, PluginTool } from "@playa0v0/cyrene-plugin-sdk";

/** 插件状态在模块内闭包持有：密钥缓存与上次查询城市。 */
let weatherApiKey: string | undefined;
let lastCity: string | undefined;

/** Open-Meteo 免密钥地理编码：城市名 → 经纬度。 */
async function geocode(city: string): Promise<{ lat: number; lon: number }> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`地理编码请求失败: HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ latitude: number; longitude: number }> };
  const hit = data.results?.[0];
  if (!hit) throw new Error(`找不到城市: ${city}`);
  return { lat: hit.latitude, lon: hit.longitude };
}

async function queryOpenMeteo(city: string): Promise<string> {
  const { lat, lon } = await geocode(city);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`天气请求失败: HTTP ${res.status}`);
  const data = (await res.json()) as {
    current?: { temperature_2m?: number; relative_humidity_2m?: number; wind_speed_10m?: number };
  };
  const cur = data.current ?? {};
  return `${city} 当前 ${cur.temperature_2m ?? "?"}°C，湿度 ${cur.relative_humidity_2m ?? "?"}%，风速 ${cur.wind_speed_10m ?? "?"} km/h（Open-Meteo）`;
}

async function queryOpenWeather(city: string, apiKey: string): Promise<string> {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${encodeURIComponent(apiKey)}&units=metric&lang=zh_cn`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`天气请求失败: HTTP ${res.status}`);
  const data = (await res.json()) as {
    name?: string;
    weather?: Array<{ description?: string }>;
    main?: { temp?: number; humidity?: number };
  };
  const desc = data.weather?.[0]?.description ?? "未知";
  return `${data.name ?? city} 当前 ${data.main?.temp ?? "?"}°C（${desc}），湿度 ${data.main?.humidity ?? "?"}%（OpenWeather）`;
}

const queryTool: PluginTool = {
  id: "weather-tool_query",
  name: "查询天气",
  description: "查询指定城市的当前天气。参数 city 为城市名（如「上海」「Tokyo」）；省略时使用上次查询过的城市。",
  enabled: true,
  risk: "network",
  effectKind: "external_side_effect",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名，省略时使用上次查询的城市" },
    },
  },
  async execute(args) {
    const city = String(args.city ?? "").trim() || lastCity;
    if (!city) return "请提供要查询的城市名（参数 city），例如：{ \"city\": \"上海\" }";

    lastCity = city;

    if (weatherApiKey) {
      try {
        return await queryOpenWeather(city, weatherApiKey);
      } catch {
        // 密钥失效等场景不中断服务，降级到免密钥数据源
      }
    }
    return queryOpenMeteo(city);
  },
};

const plugin: CyrenePlugin = {
  async register(ctx) {
    // secrets 只能从 PluginContext 拿（依赖注入），register 阶段缓存供工具闭包使用
    weatherApiKey = await ctx.deps.secrets?.get("openweathermap_key");

    // 恢复上次查询的城市
    lastCity = ctx.storage.get<string>("lastCity");

    ctx.registerTool(queryTool);

    // 停止时持久化城市，交给框架托管清理时机
    ctx.onDispose(() => {
      ctx.storage.set("lastCity", lastCity);
    });
  },
  unregister() {
    weatherApiKey = undefined;
    lastCity = undefined;
  },
};

export = plugin;

