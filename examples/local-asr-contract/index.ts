/**
 * local-asr-contract 示例：语音输入租约的完整契约。
 *
 * 真实本地 ASR 插件需要自带模型、运行时、麦克风采集和识别窗口；
 * 本示例只用模拟文本验证与宿主的交互契约：
 * 1. deps 声明 speech-input，通过 ctx.deps.speechInput 取租约
 * 2. acquire({ target: "active-chat" }) 冻结普通聊天输入目标；
 *    目标失效（页面重载/会话删除/插件停止）时 signal 触发，必须停止识别
 * 3. commit() 复用宿主正常用户输入路径，不等待模型回答；
 *    commit 失败（如会话删除）按稳定错误码分支处理
 * 4. release() 幂等；识别结束或 signal 触发都要释放，把输入权还给宿主
 */
import type {
  CyrenePlugin,
  PluginDeps,
  PluginHostError,
  PluginSpeechInputLease,
  PluginTool,
} from "@playa0v0/cyrene-plugin-sdk";
import { isPluginHostError } from "@playa0v0/cyrene-plugin-sdk";

let deps: PluginDeps = {};
/** 当前租约与识别状态：示例全局只允许一次进行中的识别。 */
let activeLease: PluginSpeechInputLease | null = null;
let recognizing = false;
let lastError: string | undefined;

/** 模拟 ASR：延迟后返回固定文本。真实插件这里是模型推理。 */
function fakeRecognize(onDone: (text: string) => void, signal: AbortSignal): void {
  const timer = setTimeout(() => onDone("你好，这是本地识别出的文本。"), 800);
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}

async function startRecognition(): Promise<string> {
  if (recognizing) return "识别进行中，请先停止当前识别";
  const speechInput = deps.speechInput!;
  try {
    const lease = await speechInput.acquire({ target: "active-chat" });
    activeLease = lease;
    recognizing = true;

    // 租约被宿主中止（页面重载、会话删除、插件停止）：立即停止识别
    lease.signal.addEventListener("abort", () => {
      recognizing = false;
      activeLease = null;
    }, { once: true });

    return await new Promise<string>((resolve) => {
      fakeRecognize(async (text) => {
        try {
          await lease.commit(text);
          resolve(`已提交识别文本: "${text}"`);
        } catch (error) {
          // 按稳定错误码分支：会话删除等不可恢复错误直接放弃
          if (isPluginHostError(error)) {
            lastError = `${(error as PluginHostError).code}: ${(error as PluginHostError).message}`;
            resolve(`提交失败: ${lastError}`);
          } else {
            resolve(`提交失败: ${String(error)}`);
          }
        } finally {
          // 无论成败都释放租约，把输入权还给宿主
          recognizing = false;
          activeLease = null;
          await lease.release().catch(() => undefined);
        }
      }, lease.signal);
    });
  } catch (error) {
    if (isPluginHostError(error)) {
      // E_SPEECH_INPUT_BUSY / E_NO_ACTIVE_INPUT_TARGET 是常见分支
      lastError = `${(error as PluginHostError).code}: ${(error as PluginHostError).message}`;
      return `获取租约失败: ${lastError}`;
    }
    throw error;
  }
}

const startTool: PluginTool = {
  id: "local-asr-contract_start",
  name: "开始语音识别",
  description: "获取语音输入租约并开始一轮模拟识别（800ms 后提交固定文本）。租约被占用或无活动聊天目标时会返回对应错误说明。",
  enabled: true,
  risk: "input-control",
  effectKind: "mutation",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    return startRecognition();
  },
};

const statusTool: PluginTool = {
  id: "local-asr-contract_status",
  name: "查看识别状态",
  description: "查看当前是否在识别、租约是否持有，以及最近一次错误。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    const lines = [
      `识别中: ${recognizing ? "是" : "否"}`,
      `持有租约: ${activeLease ? "是" : "否"}`,
    ];
    if (lastError) lines.push(`最近错误: ${lastError}`);
    return lines.join("\n");
  },
};

const plugin: CyrenePlugin = {
  async register(ctx) {
    deps = ctx.deps;
    for (const tool of [startTool, statusTool]) {
      ctx.registerTool(tool);
    }

    // 插件停止时框架会中止租约；这里兜底释放，确保输入权归还宿主
    ctx.onDispose(() => {
      const lease = activeLease;
      activeLease = null;
      recognizing = false;
      void lease?.release().catch(() => undefined);
    });
  },
  unregister() {
    lastError = undefined;
  },
};

export = plugin;
