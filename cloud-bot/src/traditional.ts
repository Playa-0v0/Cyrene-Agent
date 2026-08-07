import * as OpenCC from "opencc-js";

const converterToTw = OpenCC.Converter({ from: "cn", to: "tw" });

export function toTraditionalTaiwan(text: string): string {
  if (!text) return "";
  let result = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const converted = converterToTw(result);
    if (converted === result) break;
    result = converted;
  }
  return result
    .replace(/屏幕/g, "螢幕")
    .replace(/計算機/g, "電腦")
    .replace(/視頻/g, "影片")
    .replace(/音頻/g, "音訊")
    .replace(/支持/g, "支援");
}
