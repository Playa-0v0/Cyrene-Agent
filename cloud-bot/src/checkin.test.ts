import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CloudCheckinStore, isCloudCheckinGreeting } from "./checkin.js";

test("雲端問候辨識不會把一般對話誤判為簽到", () => {
  assert.equal(isCloudCheckinGreeting("早安"), true);
  assert.equal(isCloudCheckinGreeting("早安，今天要做什麼？"), false);
});

test("雲端同日只簽到一次並正確維護連續天數", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-cloud-checkin-"));
  const store = new CloudCheckinStore(path.join(dir, "checkin.json"));
  try {
    const first = store.record(Date.parse("2026-08-04T08:00:00+08:00"));
    const repeated = store.record(Date.parse("2026-08-04T22:00:00+08:00"));
    const next = store.record(Date.parse("2026-08-05T09:00:00+08:00"));
    assert.equal(first.total, 1);
    assert.equal(repeated.total, 1);
    assert.equal(next.total, 2);
    assert.equal(next.streak, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
