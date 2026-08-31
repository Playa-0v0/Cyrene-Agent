// 通用工具函数：浅比较 + 安全 getElementById
// 从 settings.ts 抽离，无依赖。

export function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function safeGet(id: string): HTMLElement | null {
  return document.getElementById(id);
}
