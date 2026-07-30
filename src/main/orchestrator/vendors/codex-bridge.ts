// Codex 桥 —— 用 ChatGPT 订阅（Plus/Pro/Team）驱动 Chat 模式，不需要 API Key
//
// 设计动机（跟 claude-code-bridge.ts 是同一个理由，抄的同一个思路）：
//   ChatVendorAdapter.buildRequest() 返回 HttpRequest，调度层自己发 fetch；
//   capabilities 的 transport 只有 "openai" | "anthropic" 两种封闭联合。
//   Codex 后端说的是 Responses API（POST /responses，SSE-only，Bearer + accountId
//   header），跟 OpenAICompatAdapter 生成的 Chat Completions 请求完全是两个协议。
//
//   所以还是反过来做：main 进程里起一个只绑 127.0.0.1 的最小 HTTP 服务，对外说
//   Chat Completions 协议（POST /v1/chat/completions），对内把请求翻译成 Responses
//   API 打给 https://chatgpt.com/backend-api/codex/responses，用 codex-oauth-auth
//   管的 OAuth token 鉴权。这样 openai-adapter / chat-loop / capabilities 一行都
//   不用改，新厂商只是"baseUrl 恰好指向本机"的普通 OpenAI 兼容厂商。
//
// 边界（和 Claude Code 桥一样，不是偷懒）：
//   只支持 Chat 模式。Work 模式（CITA → Action Gate → Native FC）要求厂商侧提供
//   tools + structured output；把 Cyrene 的工具定义翻译成 Responses API 自己的
//   function-tool 格式、再把结果对回 Native FC 期望的形状，是明显更大也更脆的一块
//   工作，而且不是这次要做的事。请求里带 tools / tool_choice 时直接 400。
//
// 鉴权：只监听回环地址，另外要求请求带上启动时随机生成的 bridge token——
// 挡的是同机其它进程乱打这个端口，不是防外网（回环本来就出不去）。
// 这个 bridge token 跟 Codex 那边真正的 OAuth access token是两回事：前者是 Cyrene
// 内部「调度层 → 本地桥」这一跳的门禁，后者是「本地桥 → chatgpt.com」这一跳的凭据，
// 由 CodexOAuthAuth.getValidAccessToken() 负责拿、负责刷新。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CodexOAuthAuth } from "./codex-oauth-auth";
import { proxyAwareFetch, type FetchLike } from "./proxy-fetch";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/** 请求体上限，防跑飞的 prompt 把 main 进程内存吃掉。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 调用方没指定 model 时的兜底。必须是 Codex /models 列出的 slug。 */
const DEFAULT_MODEL = "gpt-5.6-sol";
/**
 * 上游临时故障的重试退避。
 *
 * 实测数据（gpt-5.6-sol）：失败很快回来（1～2 秒），成功要 5～9 秒（模型在推理）。
 * 而 Cyrene 的"测试连接"只给 15 秒预算（openai-adapter.ts 里的 AbortController），
 * 所以重试次数和退避都必须克制——重试把自己拖过 15 秒，用户看到的是"卡死超时"，
 * 比老老实实回一个"上游过载"更难排查。
 */
const TRANSIENT_BACKOFF_MS = [500, 1200];
/**
 * 重试的总时间预算：超过这个点就不再开新一轮，直接把上游错误报出去。
 * 光靠"最多重试 N 次"控不住总时长——每轮耗时是上游说了算的。
 */
const TRANSIENT_RETRY_BUDGET_MS = 9_000;

/**
 * 判断是不是"等一会儿再试就好"的上游故障。
 * 这些文案是实测抓到的原文，不是照着文档猜的。
 */
function isTransientUpstreamError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /servers are currently overloaded/i.test(msg) ||
    /try again later/i.test(msg) ||
    /An error occurred while processing your request/i.test(msg) ||
    /\bHTTP (429|500|502|503|504)\b/.test(msg)
  );
}

export interface CodexBridgeHandle {
  /** 直接填进 settings 的 baseUrl（已含 /v1）。 */
  baseUrl: string;
  /** 直接填进 settings 的 API Key 位置——bridge 自己的门禁 token，不是 OAuth token。 */
  token: string;
  port: number;
  close(): Promise<void>;
}

interface WireContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

interface WireMessage {
  role: string;
  content?: string | WireContentBlock[];
}

interface WireRequest {
  model?: string;
  messages?: WireMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
}

function flattenContent(content: WireMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b?.type === "text" && typeof b.text === "string")
    .map(b => b.text as string)
    .join("\n");
}

/** system/developer 消息拼进 instructions；user/assistant 转 Responses input items。 */
function toResponsesPayload(messages: WireMessage[]): { instructions: string; input: unknown[] } {
  const instructionParts: string[] = [];
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      const text = flattenContent(m.content);
      if (text) instructionParts.push(text);
      continue;
    }
    if (m.role === "user") {
      input.push({ role: "user", content: [{ type: "input_text", text: flattenContent(m.content) }] });
      continue;
    }
    if (m.role === "assistant") {
      input.push({ role: "assistant", content: [{ type: "output_text", text: flattenContent(m.content) }] });
      continue;
    }
    // role: "tool" 之类：这条桥不支持 Work 模式，正常情况下调用方也不会带这种消息进来。
  }
  return { instructions: instructionParts.join("\n\n"), input };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** OpenAI 的错误信封，让 OpenAICompatAdapter 的报错路径拿到可读文案。 */
function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: "invalid_request_error" } });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体超过 8MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractToken(req: IncomingMessage): string {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return "";
}

// ── Responses API 的 SSE 收集：只关心最终态，不做增量流式转发（Chat 模式非流式）。 ──
const TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.cancelled",
  "response.canceled",
  "response.incomplete",
  "error",
]);

interface CollectedResponse {
  text: string;
  finishReason: string;
  usage: { input: number; output: number };
}

/** 从一组 output item 里抠出 output_text 文本。 */
function extractTextFromItems(items: unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "output_text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("");
}

async function collectCodexResponse(body: ReadableStream<Uint8Array>): Promise<CollectedResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latestResponse: Record<string, unknown> | undefined;
  let latestErrorMessage: string | undefined;
  // 正文的三个来源，按可靠性从高到低兜底。见下面 finalize() 的注释。
  let deltaText = "";
  const outputItems = new Map<string, unknown>();

  /**
   * 为什么要三重兜底（这不是防御性编程，是实测出来的）：
   * 实际抓到的 gpt-5.6-sol 响应里，终结事件 response.completed 的 output 是**空数组**，
   * 正文只出现在中途的 response.output_text.delta（delta="ok"）和
   * response.output_item.done（item 里带完整 content）两处。
   * 只读 response.output 会得到空字符串，然后误报成"订阅额度用尽"。
   * 参考实现（EvanZhouDev/openai-oauth 的 collectCompletedResponseFromSse）也是这么兜的：
   * 终结响应 output 为空时，用中途累积的 item 顶上。
   */
  const finalize = (): CollectedResponse => {
    const response = latestResponse ?? {};
    const fromResponse = extractTextFromItems(Array.isArray(response.output) ? response.output : []);
    const fromItems = extractTextFromItems([...outputItems.values()]);
    const usage = response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const text = fromResponse || fromItems || deltaText;

    // 上游明确报错时，必须把它的原话带出去。
    // 这里踩过坑：早先的实现把 error 事件的内容收进变量后就再没用过——只要流里出现过
    // 任何 response 对象，报错路径就走不到，于是上游真正的失败原因被"没有返回任何文本"
    // 这句自造的话盖掉，排查方向被带偏了两轮。宁可把上游原文透出来。
    if (!text) {
      const responseError = response.error as { message?: unknown } | null | undefined;
      const upstream =
        latestErrorMessage ??
        (typeof responseError?.message === "string" ? responseError.message : undefined);
      if (upstream) {
        const status = typeof response.status === "string" ? response.status : "unknown";
        throw new Error(`Codex 上游报错（status=${status}）：${upstream}`);
      }
    }

    return {
      text,
      finishReason: typeof response.status === "string" ? response.status : "stop",
      usage: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 },
    };
  };

  const processBlock = (block: string): "continue" | "terminal" => {
    let eventType: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return "continue";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return "continue";
    }
    if (eventType === "error" || parsed.type === "error") {
      const err = parsed.error as { message?: unknown } | undefined;
      latestErrorMessage = typeof err?.message === "string" ? err.message : JSON.stringify(parsed);
    }
    const type = typeof parsed.type === "string" ? parsed.type : undefined;
    // 流式正文增量
    if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
      deltaText += parsed.delta;
    }
    // 带 id 的 output item（response.output_item.added / .done）——按 id 覆盖，.done 会盖掉 .added
    const item = parsed.item;
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      outputItems.set((item as { id: string }).id, item);
    }
    const response = parsed.response;
    if (response && typeof response === "object") {
      latestResponse = response as Record<string, unknown>;
    }
    const status = latestResponse?.status;
    const terminal =
      (eventType && TERMINAL_EVENT_TYPES.has(eventType)) ||
      (type && TERMINAL_EVENT_TYPES.has(type)) ||
      (typeof status === "string" && ["completed", "failed", "cancelled", "canceled", "incomplete"].includes(status));
    return terminal ? "terminal" : "continue";
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.trim().length === 0) continue;
        if (processBlock(block) === "terminal" && latestResponse) return finalize();
      }
    }
    // 流自然结束前可能还剩最后一个未被空行分隔的块
    if (buffer.trim().length > 0) processBlock(buffer);
  } finally {
    reader.releaseLock();
  }

  if (latestResponse || deltaText || outputItems.size > 0) return finalize();
  throw new Error(`Codex 没有返回完整响应${latestErrorMessage ? `：${latestErrorMessage}` : "。"}`);
}

async function callCodexResponses(
  accessToken: string,
  accountId: string,
  model: string,
  instructions: string,
  input: unknown[],
  fetchImpl: FetchLike,
): Promise<CollectedResponse> {
  const res = await fetchImpl(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    }),
  });

  if (res.status === 401) {
    const err = new Error("Codex 后端返回 401") as Error & { codexUnauthorized: true };
    err.codexUnauthorized = true;
    throw err;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Codex 后端调用失败：HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return collectCodexResponse(res.body);
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  bridgeToken: string,
  auth: CodexOAuthAuth,
  fetchImpl: FetchLike,
): Promise<void> {
  if (!tokenMatches(extractToken(req), bridgeToken)) {
    sendError(res, 401, "Codex 桥 token 不匹配：请把设置里的 API Key 换成启动日志里的 token。");
    return;
  }

  let body: WireRequest;
  try {
    body = JSON.parse(await readBody(req)) as WireRequest;
  } catch (e) {
    sendError(res, 400, `请求体解析失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Work 模式硬拦。见文件头"边界"一节。
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    sendError(
      res,
      400,
      "ChatGPT / Codex（订阅）只支持 Chat 模式。Work 模式需要厂商侧 function calling，" +
        "把 Cyrene 的工具协议翻译到 Responses API 是另一块工作，这里没做。" +
        "请把 Work 模式切到配 API Key 的 OpenAI 兼容厂商。",
    );
    return;
  }
  if (body.tool_choice !== undefined) {
    sendError(res, 400, "ChatGPT / Codex（订阅）不支持 tool_choice：这是 Work 模式路径，请改用 API Key 厂商。");
    return;
  }
  if (body.stream === true) {
    sendError(res, 400, "Codex 桥暂不支持流式：Chat 模式当前走非流式路径。");
    return;
  }

  const status = await auth.getStatus();
  if (!status.loggedIn) {
    sendError(res, 401, "还没有登录 ChatGPT：请去设置里点击「登录 ChatGPT」完成 OAuth 授权。");
    return;
  }

  const { instructions, input } = toResponsesPayload(body.messages ?? []);
  const model = body.model ?? DEFAULT_MODEL;

  try {
    let token = await auth.getValidAccessToken();
    let result: CollectedResponse | undefined;
    let refreshedOnce = false;
    let transientRetries = 0;
    const startedAt = Date.now();

    // 两个计数器都只增不减且各有上限，循环必然终止。
    for (;;) {
      try {
        result = await callCodexResponses(token.accessToken, token.accountId, model, instructions, input, fetchImpl);
        break;
      } catch (e) {
        // 401：可能是 60s 提前刷新窗口之外的过期竞态，强制刷新一次立刻重试（不退避）。
        if ((e as { codexUnauthorized?: true }).codexUnauthorized && !refreshedOnce) {
          refreshedOnce = true;
          token = await auth.forceRefresh();
          continue;
        }
        // 上游临时性故障。实测很常见：同一个请求这次回
        // "Our servers are currently overloaded. Please try again later."，
        // 过几秒重发就成功了，跟请求内容无关。上游自己都写了让重试，
        // 不该把这种失败原样甩给用户。
        if (isTransientUpstreamError(e)) {
          const backoff = TRANSIENT_BACKOFF_MS[transientRetries];
          const withinBudget = Date.now() - startedAt + (backoff ?? 0) < TRANSIENT_RETRY_BUDGET_MS;
          if (transientRetries < TRANSIENT_BACKOFF_MS.length && withinBudget) {
            await new Promise(r => setTimeout(r, backoff));
            transientRetries++;
            continue;
          }
          throw new Error(
            `${e instanceof Error ? e.message : String(e)}` +
              `（已重试 ${transientRetries} 次仍失败。这是 OpenAI 侧的临时容量问题，` +
              `不是模型名或配置写错了，稍后再试即可。）`,
          );
        }
        throw e;
      }
    }
    if (!result) throw new Error("Codex 调用未产生结果。");

    if (!result.text) {
      // 别再瞎猜原因了。之前这里写的是"可能是订阅额度用尽"，而真实原因是 SSE 解析
      // 漏了 delta/item 两个正文来源，害得排查方向整个跑偏。把能确定的事实报出来。
      sendError(
        res,
        502,
        `Codex 返回了响应但没有可用文本（status=${result.finishReason}，` +
          `usage=${result.usage.input}/${result.usage.output}）。` +
          `如果 usage 是 0/0，通常是模型名不对；模型名请用 /models 里列出的 slug。`,
      );
      return;
    }

    sendJson(res, 200, {
      id: `chatcmpl_codex_${randomBytes(8).toString("hex")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: result.usage.input,
        completion_tokens: result.usage.output,
        total_tokens: result.usage.input + result.usage.output,
      },
    });
  } catch (e) {
    sendError(res, 502, `Codex 调用失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

export function startCodexBridge(
  auth: CodexOAuthAuth,
  /** 缺省走 Chromium 网络栈（含代理）；测试注入假实现。见 proxy-fetch.ts 的说明。 */
  fetchImpl: FetchLike = proxyAwareFetch,
): Promise<CodexBridgeHandle> {
  const token = randomBytes(24).toString("hex");

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      sendError(res, 404, "Codex 桥只提供 POST /v1/chat/completions。");
      return;
    }
    void handleChatCompletions(req, res, token, auth, fetchImpl).catch(e => {
      if (!res.headersSent) {
        sendError(res, 500, `桥内部错误：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // 只绑回环：这个端口不该被局域网看见。端口用 0 让内核分配，跟 OAuth 回调用的
    // 固定端口 1455 是两码事——那个由 OpenAI 客户端注册写死，这个纯粹是 Cyrene
    // 内部调度层访问本地桥用的，随便分配都行。
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("[CodexBridge] 拿不到监听端口"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        token,
        port: address.port,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}
