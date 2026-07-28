import { describe, expect, it } from "vitest";
import { ApplicationCommandType, ApplicationFlags, EntryPointCommandHandlerType } from "discord.js";
import {
  DISCORD_ACTIVITY_ENTRY_POINT,
  buildDiscordCurrentMusicContext,
  buildDiscordActivityInstallConfig,
  buildCyreneImageQueuedReply,
  extractOwnerCodexImageRequest,
  launchCyreneDiscordGame,
  hasDiscordActivityEnabled,
  isCodexImageOwner,
  isDiscordBotExternalDisconnect,
  normalizeDiscordInvocationText,
  shouldHandleDiscordInteraction,
  shouldHandleDiscordMessage,
} from "./index";
import type { DiscordChannelConfig } from "../../settings-store";
import { isDiscordTextVoiceRequestText } from "./text-voice-request";

function fakeMessage(options: {
  userId?: string;
  bot?: boolean;
  guildId?: string | null;
  channelId?: string;
  mentioned?: boolean;
  content?: string;
}) {
  return {
    author: { id: options.userId ?? "user-1", bot: options.bot ?? false },
    guildId: options.guildId ?? null,
    channelId: options.channelId ?? "channel-1",
    content: options.content ?? "你好",
    mentions: { users: { has: (id: string) => options.mentioned === true && id === "bot-1" } },
  } as Parameters<typeof shouldHandleDiscordMessage>[0];
}

const defaults: DiscordChannelConfig = { enabled: true, requireMention: true };

describe("DiscordAdapter message security", () => {
  it("accepts direct messages without requiring a mention", () => {
    expect(shouldHandleDiscordMessage(fakeMessage({ guildId: null }), defaults, "bot-1")).toBe(true);
  });

  it("accepts either a direct bot mention or / prefix in guild channels", () => {
    expect(shouldHandleDiscordMessage(fakeMessage({ guildId: "guild-1" }), defaults, "bot-1")).toBe(false);
    expect(shouldHandleDiscordMessage(fakeMessage({ guildId: "guild-1", mentioned: true }), defaults, "bot-1")).toBe(true);
    expect(shouldHandleDiscordMessage(fakeMessage({ guildId: "guild-1", content: "/你好" }), defaults, "bot-1")).toBe(true);
  });

  it("ignores bots and enforces all configured allowlists", () => {
    const config: DiscordChannelConfig = {
      enabled: true,
      requireMention: false,
      allowedGuildIds: ["guild-ok"],
      allowedChannelIds: ["channel-ok"],
      allowedUserIds: ["user-ok"],
    };
    expect(shouldHandleDiscordMessage(fakeMessage({ bot: true }), config, "bot-1")).toBe(false);
    expect(shouldHandleDiscordMessage(fakeMessage({ guildId: "guild-no", channelId: "channel-ok", userId: "user-ok" }), config, "bot-1")).toBe(false);
    expect(shouldHandleDiscordMessage(fakeMessage({ guildId: "guild-ok", channelId: "channel-ok", userId: "user-ok" }), config, "bot-1")).toBe(true);
  });
});

describe("DiscordAdapter invocation text", () => {
  it("removes mention and / invocation prefixes before sending text to the agent", () => {
    expect(normalizeDiscordInvocationText("<@bot-1> 你好", "bot-1")).toBe("你好");
    expect(normalizeDiscordInvocationText("/ 今天過得如何？", "bot-1")).toBe("今天過得如何？");
    expect(normalizeDiscordInvocationText("/", "bot-1")).toBe("嗨");
  });

  it("keeps existing text mode commands intact", () => {
    expect(normalizeDiscordInvocationText("/study", "bot-1")).toBe("/study");
    expect(normalizeDiscordInvocationText("/TALK", "bot-1")).toBe("/talk");
    expect(normalizeDiscordInvocationText("/collab", "bot-1")).toBe("/collab");
  });
});

describe("DiscordAdapter text voice attachment routing", () => {
  it("recognizes voice attachments independently from VC music playback", () => {
    expect(isDiscordTextVoiceRequestText("能傳一段晚安的語音嗎")).toBe(true);
    expect(isDiscordTextVoiceRequestText("能說句鳴潮牛逼嗎")).toBe(true);
    expect(isDiscordTextVoiceRequestText("能只說句鳴潮牛逼！嗎")).toBe(true);
  });

  it("does not divert normal chat or music controls into TTS attachments", () => {
    expect(isDiscordTextVoiceRequestText("今天過得如何？")).toBe(false);
    expect(isDiscordTextVoiceRequestText("下一首")).toBe(false);
    expect(isDiscordTextVoiceRequestText("暫停音樂")).toBe(false);
  });
});

describe("DiscordAdapter current music context", () => {
  it("gives the chat agent the current track and playlist without changing the user message", () => {
    const context = buildDiscordCurrentMusicContext({
      active: true,
      paused: false,
      current: {
        title: "Colorful Moonlight — Sunflower Dolls",
        url: "https://open.spotify.com/track/TRACK",
        playlistTitle: "anime",
        playlistUrl: "https://open.spotify.com/playlist/PLAYLIST",
        duration: 221,
        index: 1,
        total: 100,
      },
      queue: [{ title: "Next Song", url: "https://example.com/next", index: 2, total: 100 }],
      volume: 100,
      repeat: "off",
      shuffle: false,
      autoplay: false,
      elapsed: 212,
    });

    expect(context).toContain("Colorful Moonlight — Sunflower Dolls");
    expect(context).toContain("https://open.spotify.com/playlist/PLAYLIST");
    expect(context).toContain('"elapsedSeconds":212');
    expect(context).toContain("不要要求使用者再提供歌名或連結");
  });

  it("does not inject music context while nothing is playing", () => {
    expect(buildDiscordCurrentMusicContext(undefined)).toBeUndefined();
    expect(buildDiscordCurrentMusicContext({
      active: false,
      paused: false,
      current: null,
      queue: [],
      volume: 100,
      repeat: "off",
      shuffle: false,
      autoplay: false,
      elapsed: 0,
    })).toBeUndefined();
  });
});

describe("DiscordAdapter slash command security", () => {
  it("keeps Codex image generation locked to the dedicated owner ID", () => {
    const config: DiscordChannelConfig = {
      enabled: true,
      allowedUserIds: ["798893182883463179", "friend-id"],
      codexImageOwnerId: "798893182883463179",
    };
    expect(isCodexImageOwner(config, "798893182883463179")).toBe(true);
    expect(isCodexImageOwner(config, "friend-id")).toBe(false);
    expect(isCodexImageOwner({ enabled: true }, "798893182883463179")).toBe(false);
  });

  it("registers a Discord-managed primary Activity entry point", () => {
    expect(DISCORD_ACTIVITY_ENTRY_POINT).toMatchObject({
      type: ApplicationCommandType.PrimaryEntryPoint,
      handler: EntryPointCommandHandlerType.DiscordLaunchActivity,
    });
  });

  it("detects whether the Discord application has an Activity configuration", () => {
    expect(hasDiscordActivityEnabled(null)).toBe(false);
    expect(hasDiscordActivityEnabled({})).toBe(false);
    expect(hasDiscordActivityEnabled({ embedded_activity_config: {} })).toBe(true);
    expect(hasDiscordActivityEnabled({ flags: 0 })).toBe(false);
    expect(hasDiscordActivityEnabled({ flags: ApplicationFlags.Embedded })).toBe(true);
  });

  it("keeps existing bot permissions while enabling Activity command installation", () => {
    expect(buildDiscordActivityInstallConfig({
      integration_types_config: {
        "0": { oauth2_install_params: { scopes: ["bot"], permissions: "274877975552" } },
      },
    })).toEqual({
      integration_types_config: {
        "0": { oauth2_install_params: { scopes: ["bot", "applications.commands"], permissions: "274877975552" } },
        "1": { oauth2_install_params: { scopes: ["applications.commands"], permissions: "0" } },
      },
    });
  });

  it("applies user, channel and guild allowlists without requiring a mention", () => {
    const config: DiscordChannelConfig = {
      enabled: true,
      requireMention: true,
      allowedGuildIds: ["guild-ok"],
      allowedChannelIds: ["channel-ok"],
      allowedUserIds: ["user-ok"],
    };
    expect(shouldHandleDiscordInteraction({
      user: { id: "user-ok" }, guildId: "guild-ok", channelId: "channel-ok",
    }, config)).toBe(true);
    expect(shouldHandleDiscordInteraction({
      user: { id: "user-no" }, guildId: "guild-ok", channelId: "channel-ok",
    }, config)).toBe(false);
  });

  it("launches the game with Discord's native Activity response", async () => {
    let launches = 0;
    await launchCyreneDiscordGame({
      launchActivity: async () => { launches += 1; },
    });
    expect(launches).toBe(1);
  });
});

describe("DiscordAdapter external voice disconnect", () => {
  it("detects when Discord removes the bot from its voice channel", () => {
    expect(isDiscordBotExternalDisconnect(
      { id: "bot-1", channelId: "voice-1" },
      { id: "bot-1", channelId: null },
      "bot-1",
    )).toBe(true);
  });

  it("ignores user disconnects and bot channel moves", () => {
    expect(isDiscordBotExternalDisconnect(
      { id: "user-1", channelId: "voice-1" },
      { id: "user-1", channelId: null },
      "bot-1",
    )).toBe(false);
    expect(isDiscordBotExternalDisconnect(
      { id: "bot-1", channelId: "voice-1" },
      { id: "bot-1", channelId: "voice-2" },
      "bot-1",
    )).toBe(false);
  });
});

describe("DiscordAdapter natural-language image requests", () => {
  const config: DiscordChannelConfig = {
    enabled: true,
    codexImageOwnerId: "798893182883463179",
  };

  it("accepts short first-person keywords from the image owner", () => {
    expect(extractOwnerCodexImageRequest(
      "我想看你穿黑絲",
      config,
      "798893182883463179",
    )).toBe("我想看你穿黑絲");
  });

  it("accepts an implied Cyrene outfit request without requiring 你穿", () => {
    expect(extractOwnerCodexImageRequest(
      "我想看白絲",
      config,
      "798893182883463179",
    )).toBe("我想看白絲");
  });

  it("does not mistake unrelated things the owner wants to watch for image requests", () => {
    expect(extractOwnerCodexImageRequest(
      "我想看電影",
      config,
      "798893182883463179",
    )).toBeNull();
  });

  it("accepts explicit image generation requests from the image owner", () => {
    expect(extractOwnerCodexImageRequest(
      "幫我生成一張昔漣在星空花園的圖片",
      config,
      "798893182883463179",
    )).toBe("幫我生成一張昔漣在星空花園的圖片");
  });

  it("rejects the same request from anyone else", () => {
    expect(extractOwnerCodexImageRequest("我想看你穿黑絲", config, "friend-id")).toBeNull();
  });

  it("does not divert ordinary conversation into the image queue", () => {
    expect(extractOwnerCodexImageRequest(
      "你今天想穿什麼？",
      config,
      "798893182883463179",
    )).toBeNull();
  });

  it("uses Cyrene's playful in-character voice while changing clothes", () => {
    const reply = buildCyreneImageQueuedReply("我想看你穿黑絲");
    expect(reply).toContain("我正在換衣服呢");
    expect(reply).toContain("可不許偷看呀♪");
    expect(reply).not.toMatch(/Codex|佇列|Prompt|任務 ID/i);
  });

  it("adapts the in-character reply to scenery instead of mentioning clothes", () => {
    const reply = buildCyreneImageQueuedReply("昔漣在星空花園");
    expect(reply).toContain("那片風景");
    expect(reply).toContain("星光和花瓣");
    expect(reply).not.toContain("換衣服");
  });
});
