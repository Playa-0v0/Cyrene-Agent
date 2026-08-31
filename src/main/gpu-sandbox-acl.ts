// GPU 沙箱 DACL 启动自愈（electron/electron#51761）。
//
// 病根：部分 MSIX/AppX 安装器（向日葵等）卸载后在安装目录继承链留下孤儿
// AppContainer SID，且目录缺少 S-1-15-2-2（ALL RESTRICTED APPLICATION PACKAGES）
// 读取权限。Chromium GPU 沙箱初始化校验 DACL 失败 → int 3 断言 → 表现为
// "GPU process exited unexpectedly" 连崩后 FATAL，极易误诊为显卡驱动问题。
//
// 自愈：启动时（app ready 前，GPU 进程尚未 spawn）给 exe 目录补一条
// `*S-1-15-2-2:(OI)(CI)(RX)`。社区实测补这一条即可恢复，无需清理孤儿 SID。
// 成功后写哨兵文件，后续启动直接跳过；失败（无写 ACL 权限等）静默放过，
// 不阻塞启动——用户仍可用 disableGpuElectron 兜底。

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { logger } from "../shared/logger";

/** icacls 权限命令里必须用裸 SID（* 前缀），不能用名称——非英文系统名称会被本地化。 */
const SANDBOX_READ_SID = "*S-1-15-2-2";

export interface GpuAclHealOptions {
  platform?: NodeJS.Platform;
  isPackaged: boolean;
  exeDir: string;
  userDataDir: string;
  /** 同步执行授权命令（测试用）。 */
  runCommand?: (cmd: string) => void;
  /** 同步查询目录 ACL（测试用）；真实实现返回 icacls 输出，失败抛错。 */
  queryAcl?: (dir: string) => string;
  existsSync?: (p: string) => boolean;
  writeFileSync?: (p: string) => void;
  mkdirSync?: (p: string) => void;
}

export type GpuAclHealStatus = "skipped_dev" | "skipped_platform" | "skipped_sentinel" | "granted" | "already_ok" | "failed";

function sentinelPath(userDataDir: string): string {
  return path.join(userDataDir, "gpu-acl-ok");
}

/**
 * 同步执行（必须在 app ready 前跑完，GPU 进程起来之前）。icacls 查询/授权
 * 都是几十毫秒级，且哨兵文件保证正常情况下整个应用生命周期只执行一次。
 */
export function ensureGpuSandboxAcl(options: GpuAclHealOptions): GpuAclHealStatus {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return "skipped_platform";
  if (!options.isPackaged) return "skipped_dev";

  const run =
    options.runCommand ??
    ((cmd: string) => {
      execSync(cmd, { stdio: "ignore", timeout: 15_000, windowsHide: true });
    });
  const query =
    options.queryAcl ??
    ((dir: string) =>
      execSync(`icacls ${dir}`, { encoding: "utf8", timeout: 15_000, windowsHide: true }).toString());
  const exists = options.existsSync ?? ((p: string) => fs.existsSync(p));
  const writeSentinel = options.writeFileSync ?? ((p: string) => fs.writeFileSync(p, new Date().toISOString(), "utf8"));
  const mkdir = options.mkdirSync ?? ((p: string) => fs.mkdirSync(p, { recursive: true }));

  const marker = sentinelPath(options.userDataDir);
  if (exists(marker)) return "skipped_sentinel";

  // 目录名含空格是常态（如 E:\Program Files\...），必须加引号。
  const dir = `"${options.exeDir}"`;

  // 先查后授：多数用户目录本来就正常，避免每次重装后都执行授权写操作。
  try {
    const acl = query(dir);
    // S-1-15-2-2 通常能解析成名称（英文系统 ALL RESTRICTED APPLICATION PACKAGES，
    // 中文系统"所有受限制的应用程序包"），两者都认；解析失败时显示裸 SID。
    if (/S-1-15-2-2|RESTRICTED APPLICATION PACKAGES/i.test(acl)) {
      try {
        mkdir(options.userDataDir);
        writeSentinel(marker);
      } catch { /* 哨兵写失败无碍：下次启动重查而已 */ }
      return "already_ok";
    }
  } catch {
    // 查询失败（icacls 缺失等）→ 仍尝试授权
  }

  try {
    run(`icacls ${dir} /grant ${SANDBOX_READ_SID}:(OI)(CI)(RX) /C`);
    mkdir(options.userDataDir);
    writeSentinel(marker);
    logger.info("[GpuAclHeal] 已补装 GPU 沙箱读取权限 (S-1-15-2-2)，目录: " + options.exeDir);
    return "granted";
  } catch (err) {
    // 无管理员权限写不了 ACL 等场景：静默放过，下个启动周期重试。
    logger.warn("[GpuAclHeal] 补权限失败（下次启动重试；可用设置里的软渲染模式兜底）:", err instanceof Error ? err.message : String(err));
    return "failed";
  }
}
