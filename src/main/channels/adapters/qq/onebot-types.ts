export interface OneBotSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface OneBotSender {
  user_id?: string | number;
  nickname?: string;
  card?: string;
}

export interface OneBotMessageEvent {
  time?: number;
  self_id: string | number;
  post_type: "message" | "message_sent";
  message_type: "private" | "group";
  message_id: string | number;
  user_id: string | number;
  group_id?: string | number;
  sender?: OneBotSender;
  message: OneBotSegment[];
  raw_message?: string;
}

export interface OneBotMetaEvent {
  time?: number;
  self_id?: string | number;
  post_type: "meta_event";
  meta_event_type?: string;
}

export type OneBotEvent = OneBotMessageEvent | OneBotMetaEvent | Record<string, unknown>;

export interface OneBotResponse<T = unknown> {
  status: "ok" | "failed" | string;
  retcode: number;
  data: T;
  message?: string;
  wording?: string;
  echo?: string;
  stream?: "normal-action" | "stream-action" | string;
}

export interface OneBotStreamPacket {
  type: "stream" | "response" | "reset" | "error";
  data_type?: string;
  file_name?: string;
  file_size?: number;
  chunk_size?: number;
  index?: number;
  data?: string;
  size?: number;
  progress?: number;
  total_chunks?: number;
  total_bytes?: number;
  stream_id?: string;
  status?: string;
  file_path?: string;
  sha256?: string;
  received_chunks?: number;
}

export interface OneBotLoginInfo {
  user_id: string | number;
  nickname?: string;
}

export interface OneBotVersionInfo {
  app_name?: string;
  app_version?: string;
  protocol_version?: string;
}

export function oneBotId(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function isOneBotMessageEvent(value: unknown): value is OneBotMessageEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<OneBotMessageEvent>;
  return (event.post_type === "message" || event.post_type === "message_sent")
    && (event.message_type === "private" || event.message_type === "group")
    && Array.isArray(event.message);
}
