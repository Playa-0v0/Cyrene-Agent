// 独立验证：MiniMax（用户实际配置：transport=openai）是否拒绝 leading assistant 消息。
//
// 背景：proactive-chat 会话首条是昔涟的 assistant 主动发言，用户回复后送给模型的
// 对话呈 [{system},{assistant},{user}]。曾经假设 Anthropic Messages API 要求首条 user
// 会被 400，但用户的 MiniMax 走 OpenAI 兼容端点（capabilities.ts:11 transport=openai）。
// 本脚本实测 OpenAI 端点是否接受 leading assistant，以确认前端来源隔离是否已足够、
// 是否还需要 adapter 防御。
//
// 用法：
//   node scripts/diagnostics/check-leading-assistant.mjs
// 自动读取 userData/model-settings.json（Windows: %APPDATA%\live2d-cyrene）。
// 也可用环境变量覆盖：
//   CYRENE_BASE_URL / CYRENE_API_KEY / CYRENE_MODEL
//
// 发两个请求到 /v1/chat/completions（OpenAI 兼容）：
//   A. 控制：messages=[{role:user}]
//   B. 测试：messages=[{role:assistant},{role:user}]  （leading assistant）
// 各打印 HTTP 状态码 + 响应片段，判断 B 是否被拒。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const userData = path.join(os.homedir(), "AppData", "Roaming", "live2d-cyrene");
const cfgPath = path.join(userData, "model-settings.json");
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch {
  // 读取失败时用环境变量兜底
}

const baseUrl = process.env.CYRENE_BASE_URL || cfg.baseUrl;
const apiKey = process.env.CYRENE_API_KEY || cfg.apiKey;
const model = process.env.CYRENE_MODEL || cfg.model;

if (!baseUrl || !apiKey || !model) {
  console.error("缺少配置。设置 CYRENE_BASE_URL / CYRENE_API_KEY / CYRENE_MODEL，");
  console.error("或确保 userData/model-settings.json 存在。");
  console.error(`尝试读取: ${cfgPath}`);
  process.exit(1);
}

function buildUrl(base) {
  const t = base.trim().replace(/\/+$/, "");
  if (t.endsWith("/chat/completions")) return t;
  if (t.endsWith("/v1")) return `${t}/chat/completions`;
  return `${t}/v1/chat/completions`;
}

async function send(messages, label) {
  const body = JSON.stringify({ model, max_tokens: 64, stream: false, messages });
  const res = await fetch(buildUrl(baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body,
  });
  const text = await res.text();
  console.log(`\n=== ${label} ===`);
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 500));
  return res.status;
}

const ctrl = await send([{ role: "user", content: "ping，只回两个字符：ok" }], "A 控制 [user]");
const lead = await send(
  [
    { role: "assistant", content: "今天天气真好呀。" },
    { role: "user", content: "是呀。" },
  ],
  "B leading-assistant [assistant, user]",
);

console.log("\n=== 结论 ===");
if (ctrl >= 400) {
  console.log(`控制请求本身异常（${ctrl}），无法下结论。请检查 baseUrl/apiKey/model。`);
} else if (lead >= 400) {
  console.log(`OpenAI 端点拒绝 leading assistant（${lead}）。adapter 防御有必要。`);
} else {
  console.log("OpenAI 端点接受 leading assistant（未报错）。前端来源隔离已足够，adapter 防御非必需。");
}
