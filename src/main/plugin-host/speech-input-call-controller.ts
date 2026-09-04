/**
 * 活动通话输入控制器适配器：把通话管理器的结果式接口包装成
 * 语音租约服务需要的控制器接口，并把失败原因映射为稳定错误码。
 */
import type { SpeechInputCallController } from "./speech-input-service";
import { pluginHostError } from "./errors";
import {
  claimExternalSpeechInput,
  onCallEnded,
  releaseExternalSpeechInput,
  submitExternalText,
  type ExternalTextSubmitResult,
} from "../call/call-manager";

/** 提交失败原因 → 稳定错误码；not-owner 属于宿主不变量破坏，按内部错误处理。 */
const SUBMIT_ERROR_BY_REASON: Record<
  Exclude<ExternalTextSubmitResult, { ok: true }>["reason"],
  Parameters<typeof pluginHostError>[0]
> = {
  "no-call": "E_NOT_FOUND",
  "stale-call": "E_NOT_FOUND",
  busy: "E_SPEECH_INPUT_BUSY",
  "empty-text": "E_INVALID_ARGUMENT",
  "not-owner": "E_INTERNAL",
};

const SUBMIT_MESSAGE_BY_REASON: Record<
  Exclude<ExternalTextSubmitResult, { ok: true }>["reason"],
  string
> = {
  "no-call": "通话已结束",
  "stale-call": "通话已结束，租约冻结的通话代次已过期",
  busy: "通话正在思考或播报中，暂不能提交文本",
  "empty-text": "提交文本不能为空",
  "not-owner": "通话输入未被外部租约接管",
};

export function createSpeechInputCallController(): SpeechInputCallController {
  return {
    claimExternalInput: () => claimExternalSpeechInput(),
    commitExternalText(callGeneration, text) {
      const result = submitExternalText(callGeneration, text);
      if (result.ok) return;
      throw pluginHostError(
        SUBMIT_ERROR_BY_REASON[result.reason],
        SUBMIT_MESSAGE_BY_REASON[result.reason],
      );
    },
    releaseExternalInput: (callGeneration) => releaseExternalSpeechInput(callGeneration),
    onCallEnded: (listener) => onCallEnded(listener),
  };
}
