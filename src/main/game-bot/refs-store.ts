// refs-store —— 參考圖存儲。userData/game-bot/refs/<recipe>/<ref>.png。
// 唯一碰 electron 的模塊（app.getPath）；讀寫純 fs。
// 紅框標記編輯器裁出的小圖存這裡，運行時 vlm_click 按 ref 名讀取。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

/** 某 recipe 的參考圖目錄絕對路徑。 */
export function refsDirPath(recipeId: string): string {
  return path.join(app.getPath("userData"), "game-bot", "refs", recipeId);
}

/** 列出某 recipe 下所有參考圖名（不含 .png 後綴）。 */
export function listRefs(recipeId: string): string[] {
  const dir = refsDirPath(recipeId);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith(".png"))
      .map(f => f.slice(0, -4));
  } catch {
    return [];
  }
}

/** 讀取參考圖。返回 {base64, mime}；不存在返回 null。 */
export function readRef(recipeId: string, refName: string): { base64: string; mime: string } | null {
  const file = path.join(refsDirPath(recipeId), refName + ".png");
  try {
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    return { base64: buf.toString("base64"), mime: "image/png" };
  } catch {
    return null;
  }
}

// 說明：參考圖由用戶自行把裁好的小圖（按 ref 命名 .png）放進 refsDirPath(recipeId) 目錄。
// 不提供前端寫入入口——後端只讀。
