import * as OpenCC from "opencc-js";

const converterToTw = OpenCC.Converter({ from: "cn", to: "tw" });
const converterToCn = OpenCC.Converter({ from: "tw", to: "cn" });

/**
 * 將簡體中文文本強制轉換為繁體中文（台灣標準），並替換常見名詞。
 */
export function toTraditionalTaiwan(text: string): string {
  if (!text) return "";
  // OpenCC 的少數詞組需要第二輪才能完全收斂，例如「死灭回游」會先成為
  // 「死滅迴游」，再成為「死滅迴遊」。限制三輪並在穩定時提前停止。
  let traditional = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const converted = converterToTw(traditional);
    if (converted === traditional) break;
    traditional = converted;
  }
  // 替換一些常見的台灣/大陸用語差異（如屏幕 -> 螢幕）
  return traditional
    .replace(/屏幕/g, "螢幕")
    .replace(/計算機/g, "電腦")
    .replace(/視頻/g, "影片")
    .replace(/音頻/g, "音訊")
    .replace(/支持/g, "支援");
}

/**
 * 修正 GPT-SoVITS 在中文語境下容易發錯音、破音或讀錯聲調的多音字與常用語氣詞。
 */
export function fixPolyphones(text: string): string {
  if (!text) return "";
  let val = text;

  // 1. 動態多音字「著」->「着」(zhe) 精準校正
  val = val.replace(/([看听陪走坐想站躺笑等记抱握跟唱闪微盯守望梦离哭动哼说过照踏伴随亮躺吃喝玩耍])著/g, "$1着");
  val = val.replace(/([看听陪走坐想站躺笑等记抱握跟唱闪微盯守望梦离哭动哼说过照踏伴随亮躺吃喝玩耍])着/g, "$1着");
  val = val.replace(/著呢/g, "着呢");

  // 2. 疑問詞、語氣助詞與 OpenCC 轉譯瑕疵校正 (如 什幺 -> 什么)
  val = val.replace(/什幺|甚麼|什麼/g, "什么");
  val = val.replace(/怎幺|怎麼/g, "怎么");
  val = val.replace(/那幺|那麼/g, "那么");
  val = val.replace(/这幺|這麼/g, "这么");
  val = val.replace(/爲什麼|為什麼/g, "为什么");
  val = val.replace(/幹嘛|干嘛/g, "干嘛");
  val = val.replace(/好囉|做囉|算囉|走囉|拜拜囉|聽囉|看囉|好啰|做啰|算啰|走啰/g, (m) => m[0] + "啰");
  val = val.replace(/囉/g, "啰");
  val = val.replace(/欸|誒/g, "诶");
  val = val.replace(/喔/g, "哦");

  // 3. 多音字精準上下文校正
  val = val.replace(/還(是|有|要|在|能|會|好|行|算|想|算|不)/g, "还$1");
  val = val.replace(/长(大|高|成|相|得)/g, "长$1");

  // 4. 感嘆詞連帶 ASCII 點號清理（保留原有的 ！、？、…、～ 表情符號以精準觸發高低聲調）
  val = val.replace(/^([嗯唔啊哼哇哦诶誒喔])\.{2,}/u, "$1…");
  val = val.replace(/([。！？!?])\s*([嗯唔啊哼哇oh诶誒喔])\.{2,}/g, "$1$2…");

  return val;
}

/**
 * 將繁體中文文本轉為簡體中文（供 GPT-SoVITS / CN TTS 引擎進行文字轉音標推理）。
 */
export function toSimplifiedChinese(text: string): string {
  if (!text) return "";
  const converted = converterToCn(text);
  return fixPolyphones(converted);
}



