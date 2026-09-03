/**
 * 语音输入文本提交桥（主进程侧）。
 *
 * 把租约冻结的目标与最终文本经 IPC 送入聊天窗口渲染页：
 * - 请求携带 requestId + 冻结的 rendererTargetId + 会话/模式/文本；
 * - 渲染页必须回显 requestId 与 rendererTargetId，主进程据此忽略
 *   旧页面或错误目标返回的迟到响应；
 * - 渲染页长时间未响应按超时失败，租约侧以稳定错误码感知。
 *
 * 该 IPC 只在 Cyrene 自己的主进程与预加载层之间使用，
 * 插件无法直接拿到通道名，只能通过语音租约的 commit() 间接触发。
 */
import { webContents, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { IPC, type SpeechInputCommitResult } from "../../shared/ipc-channels";
import type { PluginHostErrorCode } from "../../plugins/api";
import type { IpcScope } from "../application/ipc-scope";
import { pluginHostError } from "./errors";
import type { SpeechInputCommitBridge } from "./speech-input-service";

/** 渲染页提交结果的等待上限；会话忙时渲染页会先回 ok（入队），正常应远小于该值。 */
const COMMIT_TIMEOUT_MS = 15_000;

interface PendingCommit {
  rendererTargetId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 渲染端回传的错误码必须是宿主稳定错误码之一，其余一律归为 E_INTERNAL。 */
function normalizeResultCode(code: unknown): PluginHostErrorCode {
  const allowed: ReadonlySet<string> = new Set([
    "E_CAPABILITY_UNAVAILABLE",
    "E_INVALID_ARGUMENT",
    "E_NOT_FOUND",
    "E_NOT_OWNER",
    "E_STORAGE_UNAVAILABLE",
    "E_SPEECH_INPUT_BUSY",
    "E_NO_ACTIVE_INPUT_TARGET",
    "E_PLUGIN_STOPPING",
    "E_INTERNAL",
  ]);
  return typeof code === "string" && allowed.has(code)
    ? (code as PluginHostErrorCode)
    : "E_INTERNAL";
}

/** 校验渲染页回传的结果形状；非法负载直接忽略（视为迟到噪声）。 */
function parseResult(payload: unknown): SpeechInputCommitResult | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    requestId?: unknown;
    rendererTargetId?: unknown;
    ok?: unknown;
    error?: unknown;
  };
  if (typeof p.requestId !== "string" || !p.requestId) return null;
  if (typeof p.rendererTargetId !== "string" || !p.rendererTargetId) return null;
  if (typeof p.ok !== "boolean") return null;
  if (p.error !== undefined) {
    const e = p.error as { code?: unknown; message?: unknown };
    if (typeof e.code !== "string" || typeof e.message !== "string") return null;
  }
  return payload as SpeechInputCommitResult;
}

export interface SpeechInputCommitBridgeOptions {
  /** 按编号查找 webContents；默认 Electron 实现，测试注入假件。 */
  lookupWebContents?: (id: number) => WebContents | null;
}

export function createSpeechInputCommitBridge(
  ipc: IpcScope,
  options: SpeechInputCommitBridgeOptions = {},
): SpeechInputCommitBridge {
  const lookupWebContents =
    options.lookupWebContents ?? ((id: number) => webContents.fromId(id) ?? null);
  const pending = new Map<string, PendingCommit>();

  // 结果监听只注册一次；requestId + rendererTargetId 双重匹配防迟到/串扰
  ipc.on(IPC.SPEECH_INPUT_COMMIT_RESULT, (_event, payload: unknown) => {
    const result = parseResult(payload);
    if (!result) return;
    const entry = pending.get(result.requestId);
    if (!entry || entry.rendererTargetId !== result.rendererTargetId) return;
    pending.delete(result.requestId);
    clearTimeout(entry.timer);
    if (result.ok) {
      entry.resolve();
      return;
    }
    const error = result.error;
    entry.reject(
      pluginHostError(
        normalizeResultCode(error?.code),
        error?.message ?? "语音文本提交失败",
      ),
    );
  });

  return {
    commit(target, text) {
      return new Promise<void>((resolve, reject) => {
        const wc = lookupWebContents(target.webContentsId);
        if (!wc || wc.isDestroyed()) {
          reject(pluginHostError("E_NO_ACTIVE_INPUT_TARGET", "目标渲染页面已失效"));
          return;
        }
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(pluginHostError("E_INTERNAL", "语音文本提交超时"));
        }, COMMIT_TIMEOUT_MS);
        pending.set(requestId, {
          rendererTargetId: target.rendererTargetId,
          resolve,
          reject,
          timer,
        });
        try {
          wc.send(IPC.SPEECH_INPUT_COMMIT_REQUEST, {
            requestId,
            rendererTargetId: target.rendererTargetId,
            sessionId: target.sessionId,
            mode: target.mode,
            text,
          });
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(pluginHostError("E_NO_ACTIVE_INPUT_TARGET", "目标渲染页面已失效", { cause: error }));
        }
      });
    },
  };
}
