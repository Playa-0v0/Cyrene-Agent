import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { downloadWechatMedia } from "./wechat-media-download";

function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

describe("downloadWechatMedia", () => {
  it("downloads CDN bytes and decrypts base64 hex AES keys", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const encrypted = encryptAesEcb(Buffer.from("hello image"), key);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength),
      text: async () => "",
    } as Response));

    const result = await downloadWechatMedia(
      {
        encrypt_query_param: "download-param",
        aes_key: Buffer.from(key.toString("hex"), "utf8").toString("base64"),
        encrypt_type: 1,
      },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=download-param",
    );
    expect(result).toEqual(Buffer.from("hello image"));
  });
});
