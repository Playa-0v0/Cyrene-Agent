// dispatcher 核心單元測試：sessionId hash + 限速
import { describe, it, expect } from "vitest";
import { extractDiscordExactVoiceText, extractDiscordVoiceRequestTopic, inferDiscordVoiceTone, isDiscordTextVoiceRequest, makeSessionId, lookupOriginalSender, normalizeChannelReplyText, prepareDiscordVoiceAgentMessage, shouldSynthesizeChannelTts } from "./dispatcher";

describe("channels/dispatcher", () => {
  it("makeSessionId: 同 channel + 同 sender → 同 sessionId", () => {
    const a = makeSessionId("feishu", "ou_abc123");
    const b = makeSessionId("feishu", "ou_abc123");
    expect(a).toBe(b);
  });

  it("makeSessionId: 跨 channel 不同 sessionId", () => {
    const f = makeSessionId("feishu", "user-x");
    const w = makeSessionId("wechat", "user-x");
    expect(f).not.toBe(w);
  });

  it("makeSessionId: 長度 16 字符 hash + 前綴", () => {
    const s = makeSessionId("feishu", "ou_abc");
    // 格式: channel:<channel>:<16 hex>
    expect(s).toMatch(/^channel:feishu:[0-9a-f]{16}$/);
  });

  it("makeSessionId: 不同 sender → 不同 sessionId", () => {
    const a = makeSessionId("feishu", "ou_aaa");
    const b = makeSessionId("feishu", "ou_bbb");
    expect(a).not.toBe(b);
  });

  it("lookupOriginalSender: 未知 sessionId 返回 null", () => {
    expect(lookupOriginalSender("channel:feishu:0000000000000000")).toBeNull();
  });

  it("Discord 文字聊天不合成 TTS，語音輪次才合成", () => {
    const base = {
      channel: "discord" as const,
      senderId: "user",
      chatId: "text-channel",
      text: "你好",
      at: new Date(),
    };
    expect(shouldSynthesizeChannelTts(base, true)).toBe(false);
    expect(shouldSynthesizeChannelTts({ ...base, _raw: { source: "discord-voice" } }, true)).toBe(true);
    expect(shouldSynthesizeChannelTts({ ...base, _raw: { source: "discord-voice" } }, false)).toBe(false);
  });

  it.each([
    "能傳一段晚安的語音嗎",
    "@昔漣 能傳一段鼓勵我的語音嗎？",
    "<@123456789012345678> 能傳一段語音嗎",
    "能傳一段介紹妳自己的語音",
    "能說句晚安",
    "能說句鼓勵我的話嗎？",
    "<@123456789012345678> 能說一句妳喜歡我嗎",
  ])("Discord 明確語音句型會觸發 TTS：%s", (text) => {
    const msg = {
      channel: "discord" as const,
      senderId: "user",
      chatId: "text-channel",
      text,
      at: new Date(),
    };
    expect(isDiscordTextVoiceRequest(msg)).toBe(true);
    expect(shouldSynthesizeChannelTts(msg, true)).toBe(true);
  });

  it("提取語音主題並改寫成確定可傳送的朗讀任務", () => {
    const msg = {
      channel: "discord" as const,
      senderId: "user",
      chatId: "text-channel",
      text: "<@123456789012345678> 能傳一段介紹妳自己的語音嗎",
      at: new Date(),
    };
    expect(extractDiscordVoiceRequestTopic(msg.text)).toBe("介紹妳自己");
    const prepared = prepareDiscordVoiceAgentMessage(msg);
    expect(prepared.text).toContain("介紹妳自己");
    expect(prepared.text).toContain("自動合成並成功發送");
    expect(prepared.text).toContain("只輸出要被朗讀的內容");
    expect(msg.text).toContain("能傳一段");
  });

  it("沒有指定主題時要求自然自由發揮", () => {
    expect(extractDiscordVoiceRequestTopic("能傳一段語音嗎")).toBe("自由發揮一段自然、親切的內容");
  });

  it("能說句句型會把後面的內容當成朗讀主題", () => {
    expect(extractDiscordVoiceRequestTopic("能說句晚安嗎")).toBe("晚安");
    expect(extractDiscordVoiceRequestTopic("能說一句鼓勵我的話")).toBe("鼓勵我的話");
  });

  it("「只說句」保留指定文字與標點，不把 emoji 當字念出來", () => {
    expect(extractDiscordExactVoiceText("能只說句鳴潮牛逼！嗎")).toBe("鳴潮牛逼！");
    expect(extractDiscordExactVoiceText("能只說一句晚安🥺嗎")).toBe("晚安……");
    expect(extractDiscordExactVoiceText("能只說句太棒了🔥嗎")).toBe("太棒了！");
    expect(extractDiscordExactVoiceText("能說句晚安嗎")).toBeNull();
  });

  it("依照標點與 emoji 決定朗讀語氣和速度", () => {
    expect(inferDiscordVoiceTone("鳴潮牛逼！")).toMatchObject({ speedMultiplier: 1.1 });
    expect(inferDiscordVoiceTone("陪陪我🥺").stylePrompt).toContain("低落");
    expect(inferDiscordVoiceTone("真的嗎？").stylePrompt).toContain("疑問");
    expect(inferDiscordVoiceTone("晚安💕").stylePrompt).toContain("甜美");
  });

  it.each(["能傳圖片嗎", "晚安", "可以用文字回答嗎", "傳一段語音的教學給我", "能說明這個功能嗎"])("普通訊息不誤觸語音：%s", (text) => {
    const msg = {
      channel: "discord" as const,
      senderId: "user",
      chatId: "text-channel",
      text,
      at: new Date(),
    };
    expect(isDiscordTextVoiceRequest(msg)).toBe(false);
  });

  it("其他渠道沿用全局 TTS 開關", () => {
    const msg = {
      channel: "wechat" as const,
      senderId: "user",
      chatId: "chat",
      text: "你好",
      at: new Date(),
    };
    expect(shouldSynthesizeChannelTts(msg, true)).toBe(true);
    expect(shouldSynthesizeChannelTts(msg, false)).toBe(false);
  });

  it("把所有外部渠道的簡體 AI 回覆轉成台灣繁體", () => {
    expect(normalizeChannelReplyText("我支持这个视频，也会继续播放列表。"))
      .toBe("我支援這個影片，也會繼續播放列表。");
  });

  it.each([
    ["partner，晚安呀。", "夥伴，晚安呀。"],
    ["YuYing，這是金毛幼犬。", "夥伴，這是金毛幼犬。"],
    ["my partner is here", "我的夥伴 is here"],
    ["partner's friend", "夥伴的朋友"],
  ])("把屋主英文別名強制換成夥伴：%s", (input, expected) => {
    expect(normalizeChannelReplyText(input)).toBe(expected);
  });
});
