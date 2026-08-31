// QR 工具层 —— 从原始 qrcode 字符串生成二维码图片（Main Process 调用）。
//
// 零 native 依赖：
//   qr-image 纯 JS 实现（png/svg/eps/buffer）
//
// 以后如果想输出 ASCII 或 SVG，替换这一层即可。
import qr from "qr-image";

/**

生成 PNG data URL（用于 <img src="...">）。
 * @param content 原始 qrcode 字符串（API 返回的 qrcode 字段）
 * @param size 二维码像素尺寸（默认 256）
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

/** 生成 SVG string（适合 CLI / 终端 ASCII 输出） */
export async function createQrSvg(content: string): Promise<string> {
  const svgBuffer = qr.image(content, { type: "svg", ec_level: "M", margin: 2 });
  const chunks: Buffer[] = [];
  for await (const chunk of svgBuffer) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
