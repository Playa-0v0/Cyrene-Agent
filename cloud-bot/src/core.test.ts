import assert from "node:assert/strict";
import test from "node:test";
import { mentionsBot, normalizeCompanionAddress, normalizeInvocation, sessionIdFor, shouldHandleMessage, splitDiscordText } from "./core.js";
import { formatCloudActivity } from "./config.js";

const baseConfig = {
  allowedUserIds: new Set<string>(),
  allowedGuildIds: new Set<string>(),
  allowedChannelIds: new Set<string>(),
  requireMention: true,
};

test("群組需要提及，私訊直接接受", () => {
  assert.equal(shouldHandleMessage({ userId: "u", guildId: "g", channelId: "c", isDm: false, mentioned: false }, baseConfig), false);
  assert.equal(shouldHandleMessage({ userId: "u", guildId: null, channelId: "c", isDm: true, mentioned: false }, baseConfig), true);
});

test("白名單會拒絕不相符的使用者", () => {
  const config = { ...baseConfig, allowedUserIds: new Set(["allowed"]) };
  assert.equal(shouldHandleMessage({ userId: "blocked", guildId: null, channelId: "c", isDm: true, mentioned: false }, config), false);
});

test("移除 bot 提及並建立穩定 session", () => {
  assert.equal(normalizeInvocation("<@123> 晚安", "123"), "晚安");
  assert.equal(sessionIdFor("u", "c"), sessionIdFor("u", "c"));
  assert.notEqual(sessionIdFor("u", "c"), sessionIdFor("u", "other"));
});

test("可辨識 Discord 的一般與暱稱提及格式", () => {
  assert.equal(mentionsBot("<@123> favorites", "123"), true);
  assert.equal(mentionsBot("<@!123> favorites", "123"), true);
  assert.equal(mentionsBot("favorites", "123"), false);
});

test("雲端回覆把英文別名統一成夥伴", () => {
  assert.equal(normalizeCompanionAddress("partner，這是狗狗。"), "夥伴，這是狗狗。");
  assert.equal(normalizeCompanionAddress("YuYing，晚安。"), "夥伴，晚安。");
  assert.equal(normalizeCompanionAddress("这个视频支持屏幕显示。"), "這個影片支援螢幕顯示。");
});

test("長訊息會切成 Discord 可接受的片段", () => {
  const chunks = splitDiscordText("a".repeat(4_100));
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900));
});

test("雲端狀態自動在『陪』前加上『在家』", () => {
  assert.equal(formatCloudActivity("陪愛爾菲玩 🌸💗✨"), "在家陪愛爾菲玩 🌸💗✨");
  assert.equal(formatCloudActivity("在家陪愛爾菲玩 🌸💗✨"), "在家陪愛爾菲玩 🌸💗✨");
  assert.equal(formatCloudActivity("在雲端守望永晝花庭"), "在雲端守望永晝花庭");
});
