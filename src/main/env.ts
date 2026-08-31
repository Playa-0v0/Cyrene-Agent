/**
 * 环境常量。
 *
 * 将 Vite 注入的运行时环境标志集中管理，避免各模块重复读取 process.env。
 */
export const isDev = process.env.VITE_DEV === "1";
