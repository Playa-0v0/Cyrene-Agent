// Obsidian 回流标志（leaf 模块，无依赖）
//
// 放在独立模块是为了让 memory-store 能【同步】读取它，避免通过动态 import
// 读取标志带来的微任务/宏任务时序问题。memory-store 在 save() 里同步检查：
// 回流期间跳过 notifyMemoryChanged()，从而避免 PMRS↔Obsidian 双向循环。
//
// obsidian-exporter 与 obsidian-importer 都从这里读写标志，无循环依赖。

let isImporting = false;

/** 标记当前是否正在从 Obsidian 回流记忆（importer 写回前 set true，结束后 set false） */
export function setImportingMemory(v: boolean): void {
  isImporting = v;
}

export function isImportingMemory(): boolean {
  return isImporting;
}
