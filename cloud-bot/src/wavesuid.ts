import { AttachmentBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import { toTraditionalTaiwan } from "./traditional.js";

const DEFAULT_GSCORE_HTTP_URL = "http://127.0.0.1:8765";
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

type GsSegment = { type?: string | null; data?: unknown };
type GsMessageSend = { content?: GsSegment[] | null };

export type WavesUidReply = { text: string; attachments: AttachmentBuilder[] };

export function isWavesUidCommand(text: string): boolean {
  return /^ww(?:fx\b|$|\s|[\p{Script=Han}\d])/iu.test(text.trim());
}

const TRADITIONAL_COMMAND_CHARS: Record<string, string> = {
  幫: "帮", 錄: "录", 掃: "扫", 碼: "码", 詢: "询", 體: "体", 曆: "历",
  設: "设", 刪: "删", 無: "无", 資: "资", 載: "载", 補: "补", 練: "练",
  統: "统", 計: "计", 記: "记", 導: "导", 連: "连", 結: "结", 兌: "兑",
  換: "换", 訂: "订", 閱: "阅", 總: "总", 傳: "传", 權: "权", 壓: "压",
  縮: "缩", 個: "个", 聲: "声", 顯: "显", 開: "开", 備: "备", 歷: "历",
};

function toSimplifiedWavesUidCommand(value: string): string {
  return value.replace(/[幫錄掃碼詢體曆設刪無資載補練統計記導連結兌換訂閱總傳權壓縮個聲顯開備歷]/gu,
    (char) => TRADITIONAL_COMMAND_CHARS[char] ?? char);
}

export function normalizeWavesUidCommand(text: string): string {
  const value = text.trim();
  if (!value) return "ww帮助";
  if (isLocalOnlyWavesUidCommand(value)) return "wwfx";
  return toSimplifiedWavesUidCommand(isWavesUidCommand(value) ? value : `ww${value}`);
}

export function isSensitiveWavesUidCommand(text: string): boolean {
  return /(?:登入|登录|登錄|扫码|掃碼|token|cookie|ck|抽卡連結|抽卡链接|導入抽卡|导入抽卡|添加)/iu.test(text);
}

export function isLocalOnlyWavesUidCommand(text: string): boolean {
  const command = text.trim().replace(/^ww\s*/iu, "").replace(/\s+/gu, "");
  if (/^(?:fx|分析|分析卡片|卡片分析|dc卡片|面板分析|分析面板|角色卡分析|分析角色卡|讀卡|读卡|讀圖|读图)$/iu.test(command)) {
    return true;
  }
  if (/(?:分析|解析|掃描|扫描)/u.test(command)) return true;
  return /(?:辨識|識別|识别|讀取|读取|看看|看一下|幫我看|帮我看)/u.test(command)
    && /(?:卡片|角色卡|面板|圖片|图片|照片|這張|这张|圖|图)/u.test(command);
}

function flattenSegments(segments: GsSegment[], output: GsSegment[] = []): GsSegment[] {
  for (const segment of segments) {
    if (segment.type === "node" && Array.isArray(segment.data)) flattenSegments(segment.data as GsSegment[], output);
    else output.push(segment);
  }
  return output;
}

function collectButtonLabels(data: unknown, result: string[] = []): string[] {
  if (Array.isArray(data)) for (const item of data) collectButtonLabels(item, result);
  else if (data && typeof data === "object") {
    const button = data as Record<string, unknown>;
    const label = typeof button.text === "string" ? button.text.trim() : "";
    const command = typeof button.data === "string" ? button.data.trim() : "";
    if (label || command) result.push(command && command !== label ? `${label || "操作"}：${command}` : label || command);
  }
  return result;
}

function inferredName(buffer: Buffer, fallback: string): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50) return `${fallback}.png`;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return `${fallback}.jpg`;
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "GIF8") return `${fallback}.gif`;
  if (buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WEBP") return `${fallback}.webp`;
  return `${fallback}.bin`;
}

function decodeAttachment(value: string, name: string): AttachmentBuilder | null {
  const buffer = Buffer.from(value.startsWith("base64://") ? value.slice(9) : value, "base64");
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return null;
  return new AttachmentBuilder(buffer, { name: /\.[a-z0-9]{2,5}$/i.test(name) ? name : inferredName(buffer, name) });
}

export function parseWavesUidResponse(payload: unknown): WavesUidReply {
  const root = payload as { status_code?: number; data?: GsMessageSend | GsMessageSend[] | null } | null;
  if (!root || root.status_code !== 200 || !root.data) {
    return { text: "WutheringWavesUID 沒有回傳內容，請確認指令是否正確，或先輸入 `ww幫助`。", attachments: [] };
  }
  const messages = Array.isArray(root.data) ? root.data : [root.data];
  const text: string[] = [];
  const attachments: AttachmentBuilder[] = [];
  let imageIndex = 0;
  for (const message of messages) {
    for (const segment of flattenSegments(Array.isArray(message.content) ? message.content : [])) {
      if (segment.type === "buttons") {
        const buttons = collectButtonLabels(segment.data);
        if (buttons.length) text.push(`可用操作：\n${buttons.map((button) => `• ${button}`).join("\n")}`);
        continue;
      }
      if (typeof segment.data !== "string") continue;
      if (segment.type === "text" || segment.type === "markdown") text.push(segment.data);
      else if (segment.type === "image") {
        if (segment.data.startsWith("base64://")) {
          const attachment = decodeAttachment(segment.data, `wavesuid-${++imageIndex}`);
          if (attachment) attachments.push(attachment);
          else text.push("[圖片過大或無法解碼]");
        } else text.push(segment.data.replace(/^link:\/\//, ""));
      } else if (segment.type === "file") {
        const [name, body] = segment.data.split(/\|(.*)/s, 2);
        if (/^(?:https?|link):\/\//i.test(body ?? "")) text.push((body ?? "").replace(/^link:\/\//, ""));
        else if (body) {
          const attachment = decodeAttachment(body, name || "wavesuid-file");
          if (attachment) attachments.push(attachment);
        }
      }
    }
  }
  return {
    text: toTraditionalTaiwan(text.join("\n").trim()) || (attachments.length ? "" : "WutheringWavesUID 已處理，但沒有可顯示的內容。"),
    attachments: attachments.slice(0, 10),
  };
}

async function requestWavesUid(
  command: string,
  context: {
    botSelfId: string; messageId: string; userId: string; userName: string; userAvatar?: string;
    channelId?: string | null; isDirect: boolean;
    attachments?: Array<{ name: string; url: string; contentType?: string | null }>;
  },
): Promise<WavesUidReply> {
  const content: GsSegment[] = [{ type: "text", data: normalizeWavesUidCommand(command) }];
  for (const attachment of context.attachments ?? []) {
    const image = attachment.contentType?.toLowerCase().startsWith("image/") || /\.(?:png|jpe?g|webp|gif)$/i.test(attachment.name);
    content.push(image ? { type: "image", data: attachment.url } : { type: "file", data: `${attachment.name}|${attachment.url}` });
  }
  const baseUrl = process.env.GSCORE_HTTP_URL?.trim() || DEFAULT_GSCORE_HTTP_URL;
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/send_msg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bot_id: "discord",
        bot_self_id: context.botSelfId,
        msg_id: context.messageId,
        user_type: context.isDirect ? "direct" : "group",
        group_id: context.isDirect ? null : context.channelId,
        user_id: context.userId,
        sender: { nickname: context.userName, avatar: context.userAvatar },
        user_pm: 6,
        content,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new Error(`無法連到 GsCore（${baseUrl}）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`GsCore HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
  return parseWavesUidResponse(await response.json());
}

function payload(reply: WavesUidReply) {
  return { content: reply.text.slice(0, 2000) || undefined, files: reply.attachments, allowedMentions: { repliedUser: false } };
}

export async function handleWavesUidMessage(message: Message, command: string, botSelfId: string): Promise<void> {
  if (isLocalOnlyWavesUidCommand(command) || message.attachments.size > 0) {
    await message.reply({ content: "截圖分析只會在你的 Mac 本機執行。請開啟昔漣的「鳴潮工具」，從 Electron 選擇截圖。", allowedMentions: { repliedUser: false } });
    return;
  }
  if (message.guildId && isSensitiveWavesUidCommand(command)) {
    await message.reply({ content: "這個指令可能包含登入憑證，請改用私訊昔漣執行。", allowedMentions: { repliedUser: false } });
    return;
  }
  if ("sendTyping" in message.channel) {
    await message.channel.sendTyping().catch(() => undefined);
  }
  const reply = await requestWavesUid(command, {
    botSelfId,
    messageId: message.id,
    userId: message.author.id,
    userName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    userAvatar: message.author.displayAvatarURL({ size: 256 }),
    channelId: message.channelId,
    isDirect: !message.guildId,
    attachments: [...message.attachments.values()].map((item) => ({ name: item.name, url: item.url, contentType: item.contentType })),
  });
  await message.reply(payload(reply));
}

export async function handleWavesUidInteraction(interaction: ChatInputCommandInteraction, command: string, botSelfId: string): Promise<void> {
  const file = interaction.options.getAttachment("file");
  if (isLocalOnlyWavesUidCommand(command) || file) {
    await interaction.reply({ content: "截圖分析只會在你的 Mac 本機執行。請開啟昔漣的「鳴潮工具」，從 Electron 選擇截圖。", ephemeral: true });
    return;
  }
  if (interaction.guildId && isSensitiveWavesUidCommand(command)) {
    await interaction.reply({ content: "這個指令可能包含登入憑證，請改用私訊昔漣執行。", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const reply = await requestWavesUid(command, {
    botSelfId,
    messageId: interaction.id,
    userId: interaction.user.id,
    userName: interaction.user.globalName ?? interaction.user.username,
    userAvatar: interaction.user.displayAvatarURL({ size: 256 }),
    channelId: interaction.channelId,
    isDirect: !interaction.guildId,
    attachments: [],
  });
  await interaction.editReply(payload(reply));
}
