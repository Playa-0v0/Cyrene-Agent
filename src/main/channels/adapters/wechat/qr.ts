// QR 工具層 —— 從原始 qrcode 字符串生成二維碼圖片（Main Process 調用）。
//
// 零 native 依賴：
//   qr-image 純 JS 實現（png/svg/eps/buffer）
//
// 以後如果想輸出 ASCII 或 SVG，替換這一層即可。
import qr from "qr-image";

/**

生成 PNG data URL（用於 <img src="...">）。
 * @param content 原始 qrcode 字符串（API 返回的 qrcode 字段）
 * @param size 二維碼像素尺寸（默認 256）
 */
export async function createQrDataUrl(content: string, size = 256): Promise<string> {
  const pngBuffer = qr.image(content, { type: "png", ec_level: "M", margin: 2, size });
  const chunks: Buffer[] = [];
  for await (const chunk of pngBuffer) {
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/** 生成 SVG string（適合 CLI / 終端 ASCII 輸出） */
export async function createQrSvg(content: string): Promise<string> {
  const svgBuffer = qr.image(content, { type: "svg", ec_level: "M", margin: 2 });
  const chunks: Buffer[] = [];
  for await (const chunk of svgBuffer) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
