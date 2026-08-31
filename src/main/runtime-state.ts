import { STATUS_KEYWORDS } from "./status-keywords";

export type RuntimeStatus = "陪伴中" | "思考中" | "工作中" | "聆听中" | "提醒中" | "离线";
export type RuntimeFeeling = "平静" | "开心" | "温柔" | "激动" | "撒娇" | "担心" | "难过" | "感动" | "害羞";

export interface RuntimeState {
  status: RuntimeStatus;
  feeling: RuntimeFeeling;
  expression: number;
  updatedAt: number;
}

export const RUNTIME_STATUSES: RuntimeStatus[] = ["陪伴中", "思考中", "工作中", "聆听中", "提醒中", "离线"];
export const RUNTIME_FEELINGS: RuntimeFeeling[] = ["平静", "开心", "温柔", "激动", "撒娇", "担心", "难过", "感动", "害羞"];

export const feelingToExpression: Record<string, number> = {
  "平静": 0,
  "开心": 6,
  "温柔": 0,
  "激动": 3,
  "撒娇": 5,
  "担心": 2,
  "难过": 0,
  "感动": 4,
  "害羞": 5,
};

export function inferRuntimeState(
  userInput: string,
  llmReply: string,
  toolCalled: boolean,
): Pick<RuntimeState, "status"> {
  if (toolCalled) return { status: "工作中" };

  const text = userInput + llmReply;

  if (STATUS_KEYWORDS["聆听中"].test(text)) {
    return { status: "聆听中" };
  }

  if (STATUS_KEYWORDS["思考中"].test(text)) {
    return { status: "思考中" };
  }

  return { status: "陪伴中" };
}
