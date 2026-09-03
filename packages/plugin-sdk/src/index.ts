/**
 * SDK 主入口：再导出宿主公开契约（api.ts 由构建脚本从 src/plugins/api.ts
 * 原样同步，verify-package 会检查两份文件无漂移）和 Manifest 校验入口。
 */
export * from "./api";
export * from "./validate-manifest";
