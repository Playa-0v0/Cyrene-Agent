// input —— 鍵鼠控制（@nut-tree-fork/nut-js）。
// 高風險操作：真實控制用戶鼠標鍵盤。僅供 game-bot 引擎調用，走權限網關。
//
// 注意：nut.js 是 native 模塊，Electron 需 electron-rebuild 重編譯。
// 若啟動報 native 模塊錯誤，備選 koffi + user32 SendInput（見 plan Task 6/13 驗證點）。

import { mouse, Point, keyboard, Key } from "@nut-tree-fork/nut-js";

/** 特殊鍵名 → nut.js Key。單字母（A-Z）走動態解析。 */
const KEY_MAP: Record<string, Key> = {
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  Escape: Key.Escape, Esc: Key.Escape, Enter: Key.Enter, Return: Key.Enter,
  Space: Key.Space, Tab: Key.Tab, Backspace: Key.Backspace, Delete: Key.Delete,
  Alt: Key.LeftAlt, Ctrl: Key.LeftControl, Control: Key.LeftControl, Shift: Key.LeftShift,
  Win: Key.LeftSuper, Meta: Key.LeftSuper,
};

/** 鍵名 → Key。支持 F1-12 / Escape / Enter / 修飾鍵 / 單字母 A-Z。未知返回 null。 */
function resolveKey(name: string): Key | null {
  const upper = name.trim();
  if (KEY_MAP[upper] !== undefined) return KEY_MAP[upper];
  if (/^[A-Z]$/.test(upper)) {
    const k = (Key as unknown as Record<string, Key>)[upper];
    return k ?? null;
  }
  return null;
}

/** 移動到 (x,y) 並左鍵單擊一次。 */
export async function click(x: number, y: number): Promise<void> {
  await mouse.setPosition(new Point(x, y));
  await mouse.leftClick();
}

/** 點擊屏幕中心。 */
export async function clickCenter(width: number, height: number): Promise<void> {
  await click(Math.floor(width / 2), Math.floor(height / 2));
}

/** 按組合鍵。combo 形如 "F4" / "Alt+F4" / "Escape" / "V"。 */
export async function keyPress(combo: string): Promise<void> {
  const parts = combo.split("+").map(s => s.trim());
  const keys = parts.map(resolveKey).filter((k): k is Key => k !== null);
  if (keys.length === 0) {
    console.warn("[GameBot] 未知鍵組合，跳過:", combo);
    return;
  }
  await keyboard.pressKey(...keys);
  await keyboard.releaseKey(...keys.slice().reverse());
}
