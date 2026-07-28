// Stable Wispbyte entry point. A versioned import prevents stale host module caches.
import { readFileSync, statSync } from "node:fs";

const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
console.log(`[Cyrene Entry] index.js bytes=${statSync(new URL("./index.js", import.meta.url)).size} parity=${source.includes("cloud-parity-20260727-1")}`);
await import("./index.js?build=cloud-parity-20260727-1");
