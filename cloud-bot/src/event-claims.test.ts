import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventClaimStore } from "./event-claims.js";

test("多個程序共享資料夾時，同一 Discord 事件只能取得一次", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cyrene-claims-"));
  try {
    const first = new EventClaimStore(directory);
    const second = new EventClaimStore(directory);
    assert.equal(first.claim("interaction-123"), true);
    assert.equal(second.claim("interaction-123"), false);
    assert.equal(second.claim("interaction-456"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
