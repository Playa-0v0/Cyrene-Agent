import assert from "node:assert/strict";
import test from "node:test";
import { CloudMusicPlayer, extractPlayableUrl } from "./music-player.js";

test("可從影片標題加網址中自動擷取播放網址", () => {
  const url = extractPlayableUrl("【2026 上半年熱門歌曲】 https://www.bilibili.com/video/BV123?vd_source=abc");
  assert.equal(url.toString(), "https://www.bilibili.com/video/BV123?vd_source=abc");
});

test("會移除網址後方的中文標點", () => {
  const url = extractPlayableUrl("請播放 https://youtu.be/example。謝謝");
  assert.equal(url.toString(), "https://youtu.be/example");
});

test("沒有網址時會顯示容易理解的錯誤", () => {
  assert.throws(() => extractPlayableUrl("只有影片名稱"), /找不到網址/);
});

test("未加入 Discord 語音頻道時不會誤報雲端通話", () => {
  const player = new CloudMusicPlayer("/tmp/cyrene-cloud-music-test");
  assert.equal(player.snapshot().voiceActive, false);
});
