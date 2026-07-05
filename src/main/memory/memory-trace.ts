import * as fs from "fs"
import * as path from "path"
import { app } from "electron"

export interface MemoryTraceEvent {
  ts?: number
  op: string
  layer?: "L0" | "L1" | "L2" | "store" | "reflection" | "migration"
  status: "ok" | "error" | "skip"
  l2Id?: string
  ragId?: string
  details?: Record<string, unknown>
  error?: string | null
}

function getTracePath(): string {
  return path.join(app.getPath("userData"), "memory-trace.log")
}

export function appendMemoryTrace(event: MemoryTraceEvent): void {
  try {
    const filePath = getTracePath()
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const entry = {
      ts: event.ts ?? Date.now(),
      ...event,
      error: event.error ?? null,
    }
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8")
  } catch (err) {
    console.warn("[MemoryTrace] 写入失败:", err)
  }
}
