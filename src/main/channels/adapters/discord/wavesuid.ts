import { AttachmentBuilder, type Message, type RepliableInteraction } from "discord.js";
import { createHash } from "crypto";
import { toSimplifiedChinese, toTraditionalTaiwan } from "../../../utils/opencc";

const DEFAULT_GSCORE_HTTP_URL = "http://127.0.0.1:8765";
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const LOGIN_TIMEOUT_MS = 620_000;
const activeLoginSessions = new Map<string, Promise<WavesUidReply>>();

type GsSegment = { type?: string | null; data?: unknown };
type GsMessageSend = { content?: GsSegment[] | null };

export interface WavesUidRequestContext {
  botSelfId: string;
  messageId: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  channelId?: string | null;
  isDirect: boolean;
  attachments?: Array<{ name: string; url: string; contentType?: string | null }>;
}

export interface WavesUidReply {
  text: string;
  attachments: AttachmentBuilder[];
}

export function isWavesUidCommand(text: string): boolean {
  return /^ww(?:fx\b|$|\s|[\p{Script=Han}\d])/iu.test(text.trim());
}

export function normalizeWavesUidCommand(text: string): string {
  const value = text.trim();
  if (!value) return "ww帮助";
  if (isLocalOnlyWavesUidCommand(value)) return "wwfx";
  const normalized = toSimplifiedChinese(isWavesUidCommand(value) ? value : `ww${value}`);
  if (/^ww\s*练度$/iu.test(normalized)) return "ww练度统计";
  return normalized;
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

function isBareWavesUidCommand(text: string): boolean {
  return /^ww\s*$/iu.test(text.trim());
}

export function isWavesUidLoginCommand(text: string): boolean {
  // 文字指令會帶 ww；Slash /ww 的 option 僅會傳入「登入」。
  return /^(?:ww\s*)?(?:登入|登录|登錄)$/iu.test(text.trim());
}

function flattenSegments(segments: GsSegment[], output: GsSegment[] = []): GsSegment[] {
  for (const segment of segments) {
    if (segment.type === "node" && Array.isArray(segment.data)) {
      flattenSegments(segment.data as GsSegment[], output);
    } else {
      output.push(segment);
    }
  }
  return output;
}

function collectButtonLabels(data: unknown, result: string[] = []): string[] {
  if (Array.isArray(data)) {
    for (const item of data) collectButtonLabels(item, result);
  } else if (data && typeof data === "object") {
    const button = data as Record<string, unknown>;
    const label = typeof button.text === "string" ? button.text.trim() : "";
    const command = typeof button.data === "string" ? button.data.trim() : "";
    if (label || command) result.push(command && command !== label ? `${label || "操作"}：${command}` : label || command);
  }
  return result;
}

function attachmentName(buffer: Buffer, fallback: string): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50) return `${fallback}.png`;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return `${fallback}.jpg`;
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "GIF8") return `${fallback}.gif`;
  if (buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WEBP") return `${fallback}.webp`;
  return `${fallback}.bin`;
}

function decodeBase64Attachment(value: string, name: string): AttachmentBuilder | null {
  const encoded = value.startsWith("base64://") ? value.slice(9) : value;
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return null;
  const finalName = /\.[a-z0-9]{2,5}$/i.test(name) ? name : attachmentName(buffer, name);
  return new AttachmentBuilder(buffer, { name: finalName });
}

function formatWavesUidText(value: string): string {
  const text = toTraditionalTaiwan(value).trim();
  const success = /\[鳴潮\]\s*uid\s*:\s*(\d+)\s*的\s*dc\s*卡片數據提取成功/iu.exec(text);
  if (!success) return text;

  const commands = [...text.matchAll(/【\s*([^】]+?)\s*】/gu)].map((match) => match[1].trim());
  if (commands.length < 3) return text;

  const suiteMode = /圖像匹配|圖像比對/u.test(text) ? "圖像比對" : "預設配置";
  const lines = [
    "✅ **鳴潮卡片分析完成**",
    `**UID：** \`${success[1]}\``,
    `**套裝辨識：** ${suiteMode}`,
    "> 套裝辨識會影響傷害計算，但不影響聲骸評分。",
    "",
    "**可用指令**",
    `- \`${commands[0]}\` — 查看角色面板`,
    `- \`${commands[1]}\` — 修改聲骸套裝`,
    `- \`${commands[2]}\` — 修改目前套裝的首位聲骸`,
  ];

  const example = /可使用如\s+([^\s)）]+(?:\s*改為\s*3\+2套裝)?)/u.exec(text)?.[1]
    ?? /(?:例如|如)\s*([^\s)）]+)/u.exec(text)?.[1];
  if (example) lines.splice(lines.length - 1, 0, `  - 例如：\`${example}\``);
  return lines.join("\n");
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
    const segments = flattenSegments(Array.isArray(message.content) ? message.content : []);
    for (const segment of segments) {
      if (typeof segment.data !== "string" && segment.type !== "buttons") continue;
      if (segment.type === "text" || segment.type === "markdown") {
        text.push(String(segment.data));
      } else if (segment.type === "image") {
        const image = String(segment.data);
        if (image.startsWith("base64://")) {
          const attachment = decodeBase64Attachment(image, `wavesuid-${++imageIndex}`);
          if (attachment) attachments.push(attachment);
          else text.push("[圖片過大或無法解碼]");
        } else {
          text.push(image.replace(/^link:\/\//, ""));
        }
      } else if (segment.type === "file") {
        const [name, body] = String(segment.data).split(/\|(.*)/s, 2);
        if (/^(?:https?|link):\/\//i.test(body ?? "")) text.push((body ?? "").replace(/^link:\/\//, ""));
        else if (body) {
          const attachment = decodeBase64Attachment(body, name || "wavesuid-file");
          if (attachment) attachments.push(attachment);
        }
      } else if (segment.type === "buttons") {
        const buttons = collectButtonLabels(segment.data);
        if (buttons.length) text.push(`可用操作：\n${buttons.map((button) => `• ${button}`).join("\n")}`);
      }
    }
  }

  return {
    text: formatWavesUidText(text.join("\n")) || (attachments.length ? "" : "WutheringWavesUID 已處理，但沒有可顯示的內容。"),
    attachments: attachments.slice(0, 10),
  };
}

export async function requestWavesUid(
  command: string,
  context: WavesUidRequestContext,
  baseUrl = process.env.GSCORE_HTTP_URL?.trim() || DEFAULT_GSCORE_HTTP_URL,
  timeoutMs = 120_000,
): Promise<WavesUidReply> {
  const content: GsSegment[] = [{ type: "text", data: normalizeWavesUidCommand(command) }];
  for (const attachment of context.attachments ?? []) {
    const isImage = attachment.contentType?.toLowerCase().startsWith("image/")
      || /\.(?:png|jpe?g|webp|gif)$/i.test(attachment.name);
    content.push(isImage
      ? { type: "image", data: attachment.url }
      : { type: "file", data: `${attachment.name}|${attachment.url}` });
  }

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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`無法連到 GsCore（${baseUrl}）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`GsCore HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
  return parseWavesUidResponse(await response.json());
}

export interface WavesUidLoginSession {
  url: string;
  completion: Promise<WavesUidReply>;
}

/**
 * 建立一次性登入頁。頁面僅綁定 GsCore 的 loopback HTTP，Discord 只負責送出一則私人連結。
 */
export async function startWavesUidLogin(
  context: WavesUidRequestContext,
  baseUrl = process.env.GSCORE_HTTP_URL?.trim() || DEFAULT_GSCORE_HTTP_URL,
): Promise<WavesUidLoginSession> {
  const origin = new URL(baseUrl);
  if (!/^(?:127\.0\.0\.1|localhost|::1)$/iu.test(origin.hostname)) {
    throw new Error("國際服登入頁只能由本機 GsCore 提供，請不要將登入服務公開到網路。");
  }
  const auth = createHash("sha256").update(context.userId).digest("hex").slice(0, 8);
  const loginUrl = `${origin.origin}/waves/i/${auth}`;
  const sessionKey = `${origin.origin}:${context.userId}`;
  let completion = activeLoginSessions.get(sessionKey);
  if (!completion) {
    completion = requestWavesUid("登入", context, origin.origin, LOGIN_TIMEOUT_MS)
      .finally(() => activeLoginSessions.delete(sessionKey));
    activeLoginSessions.set(sessionKey, completion);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(loginUrl, { signal: AbortSignal.timeout(1_500) });
      const html = await response.text();
      if (response.ok && /國際服登入|international\/login/u.test(html)) {
        return { url: loginUrl, completion };
      }
    } catch { /* 登入處理器正在建立一次性頁面。 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("本機登入頁準備逾時，請確認昔漣與 GsCore 都在這台 Mac 上執行。");
}

function replyPayload(reply: WavesUidReply) {
  return {
    content: reply.text.slice(0, 2000) || undefined,
    files: reply.attachments,
    allowedMentions: { repliedUser: false },
  };
}

export async function handleWavesUidMessage(message: Message, command: string, botSelfId: string): Promise<void> {
  const shouldAnalyze = isLocalOnlyWavesUidCommand(command)
    || (message.attachments.size > 0 && isBareWavesUidCommand(command));
  if (shouldAnalyze && message.attachments.size === 0) {
    await message.reply({ content: "請在同一則訊息附上 wuwa bot 產生的角色卡圖片，例如：`wwfx`＋圖片。辨識會在你的 Mac 本機執行。", allowedMentions: { repliedUser: false } });
    return;
  }
  if (isWavesUidLoginCommand(command)) {
    if (message.guildId) {
      await message.reply({ content: "請改用 Slash 指令 `/ww`，將 command 填為 `登入`。昔漣會以「只有你能看見」的私人回覆送出登入連結。", allowedMentions: { repliedUser: false } });
      return;
    }
    const context: WavesUidRequestContext = {
      botSelfId,
      messageId: message.id,
      userId: message.author.id,
      userName: message.author.globalName ?? message.author.username,
      userAvatar: message.author.displayAvatarURL({ size: 256 }),
      channelId: message.channelId,
      isDirect: true,
    };
    try {
      const session = await startWavesUidLogin(context);
      await message.reply({
        content: `[鳴潮] 您的 id 為 【${context.userId}】\n請在**這台正在跑昔漣的 Mac** 開啟：[連結國際服帳號](${session.url})\n登入地址 10 分鐘內有效`,
        allowedMentions: { repliedUser: false },
      });
      // GsCore 會在建立頁面後回傳一段舊式登入提示；流程已由上方連結涵蓋，
      // 只消耗它以維持登入 session，避免使用者收到第二則重複訊息。
      void session.completion.catch(() => undefined);
    } catch (error) {
      await message.reply({ content: `無法建立本機登入頁：${error instanceof Error ? error.message : String(error)}`, allowedMentions: { repliedUser: false } });
    }
    return;
  }
  if (message.guildId && isSensitiveWavesUidCommand(command)) {
    await message.reply({ content: "這個指令可能包含登入憑證，請改用私訊昔漣執行。", allowedMentions: { repliedUser: false } });
    return;
  }
  if ("sendTyping" in message.channel) {
    await message.channel.sendTyping().catch(() => undefined);
  }
  const reply = await requestWavesUid(shouldAnalyze ? "wwfx" : command, {
    botSelfId,
    messageId: message.id,
    userId: message.author.id,
    userName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    userAvatar: message.author.displayAvatarURL({ size: 256 }),
    channelId: message.channelId,
    isDirect: !message.guildId,
    attachments: [...message.attachments.values()].map((attachment) => ({
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
    })),
  });
  await message.reply(replyPayload(reply));
}

export async function handleWavesUidInteraction(
  interaction: RepliableInteraction & { channelId: string | null; guildId: string | null },
  command: string,
  botSelfId: string,
  attachment?: { name: string; url: string; contentType?: string | null },
): Promise<void> {
  const shouldAnalyze = isLocalOnlyWavesUidCommand(command) || (Boolean(attachment) && isBareWavesUidCommand(command));
  if (shouldAnalyze && !attachment) {
    await interaction.reply({ content: "請附上 wuwa bot 產生的角色卡圖片。辨識會在你的 Mac 本機執行。", ephemeral: true });
    return;
  }
  if (isWavesUidLoginCommand(command)) {
    const context: WavesUidRequestContext = {
      botSelfId,
      messageId: interaction.id,
      userId: interaction.user.id,
      userName: interaction.user.globalName ?? interaction.user.username,
      userAvatar: interaction.user.displayAvatarURL({ size: 256 }),
      channelId: interaction.channelId,
      // 連結本身由 Discord ephemeral 回覆保護；GsCore 事件仍以私訊語義處理，
      // 避免插件把登入狀態廣播到目前伺服器頻道。
      isDirect: true,
    };
    try {
      const session = await startWavesUidLogin(context);
      await interaction.reply({
        content: `[鳴潮] 您的 id 為 【${context.userId}】\n請在**這台正在跑昔漣的 Mac** 開啟：[連結國際服帳號](${session.url})\n登入地址 10 分鐘內有效`,
        ephemeral: true,
      });
      // 不轉發 GsCore 的舊式登入提示：Discord 端只保留上方一則 ephemeral 連結。
      void session.completion.catch(() => undefined);
    } catch (error) {
      await interaction.reply({ content: `無法建立本機登入頁：${error instanceof Error ? error.message : String(error)}`, ephemeral: true });
    }
    return;
  }
  if (interaction.guildId && isSensitiveWavesUidCommand(command)) {
    await interaction.reply({ content: "這個指令可能包含登入憑證，請改用私訊昔漣執行。", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const reply = await requestWavesUid(shouldAnalyze ? "wwfx" : command, {
    botSelfId,
    messageId: interaction.id,
    userId: interaction.user.id,
    userName: interaction.user.globalName ?? interaction.user.username,
    userAvatar: interaction.user.displayAvatarURL({ size: 256 }),
    channelId: interaction.channelId,
    isDirect: !interaction.guildId,
    attachments: attachment ? [attachment] : [],
  });
  await interaction.editReply(replyPayload(reply));
}
