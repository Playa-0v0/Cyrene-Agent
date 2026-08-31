import { describe, it, expect, beforeEach } from "vitest";
import { OpenapiConfigStore } from "./openapi-config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-config-"));
});

const VALID = { appId: "b3010d00000000009b4d0c1cfda9accd", privateKey: "A".repeat(1600) };
const VALID_PEM = {
  appId: "a",
  privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
};

describe("OpenapiConfigStore", () => {
  it("round-trips save/load", async () => {
    const store = new OpenapiConfigStore(dir);
    await store.save(VALID);
    expect(await store.load()).toEqual(VALID);
  });

  it("returns null when not configured", async () => {
    expect(await new OpenapiConfigStore(dir).load()).toBeNull();
  });

  it("throws E_OPENAPI_CONFIG_UNREADABLE on corrupt json / missing fields", async () => {
    await fs.writeFile(path.join(dir, "openapi-config.json"), "{oops");
    await expect(new OpenapiConfigStore(dir).load()).rejects.toThrow(/E_OPENAPI_CONFIG_UNREADABLE/);
    await fs.writeFile(path.join(dir, "openapi-config.json"), JSON.stringify({ appId: "x" }));
    await expect(new OpenapiConfigStore(dir).load()).rejects.toThrow(/appId\/privateKey missing/);
  });

  it("save() validates before writing", async () => {
    const store = new OpenapiConfigStore(dir);
    await expect(store.save({ appId: "", privateKey: "k" })).rejects.toThrow(/E_OPENAPI_CONFIG_INVALID/);
    await expect(store.save({ appId: "a", privateKey: "short" })).rejects.toThrow(/E_OPENAPI_CONFIG_INVALID/);
    await expect(store.save(VALID_PEM)).resolves.toBeUndefined(); // PEM accepted
  });

  it("loadValidated returns null instead of throwing for invalid stored config", async () => {
    const store = new OpenapiConfigStore(dir);
    await fs.writeFile(path.join(dir, "openapi-config.json"), JSON.stringify({ appId: "x", privateKey: "y" }));
    expect(await store.loadValidated()).toBeNull();
  });

  it("delete() removes the file (idempotent)", async () => {
    const store = new OpenapiConfigStore(dir);
    await store.save(VALID);
    await store.delete();
    await store.delete();
    expect(await store.load()).toBeNull();
  });
});
