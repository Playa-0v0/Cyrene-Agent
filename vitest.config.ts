import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/main/**/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/cli/**/*.test.ts",
      "skills/**/tests/**/*.test.ts",
      "scripts/cline-poc/**/*.test.ts",
    ],
    // 单 fork 单 worker，避免 Windows 下 libuv fs-event 断言崩溃
    pool: "forks",
    singleFork: true,
    maxWorkers: 1,
    minWorkers: 1,
    // 明确禁用 watch/cache，减少 fs 事件
    watch: false,
    cache: false,
    fileParallelism: false,
  },
});
