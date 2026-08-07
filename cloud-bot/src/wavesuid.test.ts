import test from "node:test";
import assert from "node:assert/strict";
import { isSensitiveWavesUidCommand, isWavesUidCommand, normalizeWavesUidCommand, parseWavesUidResponse } from "./wavesuid.js";

test("cloud WutheringWavesUID command routing and response parsing", () => {
  assert.equal(isWavesUidCommand("ww幫助"), true);
  assert.equal(isWavesUidCommand("一起玩鳴潮"), false);
  assert.equal(normalizeWavesUidCommand("今汐面板"), "ww今汐面板");
  assert.equal(normalizeWavesUidCommand("ww幫助"), "ww帮助");
  assert.equal(normalizeWavesUidCommand("查詢體力"), "ww查询体力");
  assert.equal(isSensitiveWavesUidCommand("ww登入"), true);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const reply = parseWavesUidResponse({
    status_code: 200,
    data: { content: [{ type: "text", data: "查询完成" }, { type: "image", data: `base64://${png}` }] },
  });
  assert.match(reply.text, /查詢完成/);
  assert.equal(reply.attachments.length, 1);
  assert.equal(reply.attachments[0].name, "wavesuid-1.png");
});
