import { describe, expect, it, vi } from "vitest";
import { ensureGpuSandboxAcl } from "./gpu-sandbox-acl";

const base = {
  platform: "win32" as NodeJS.Platform,
  isPackaged: true,
  exeDir: "E:\\cyrene",
  userDataDir: "C:\\Users\\u\\AppData\\Roaming\\live2d-cyrene",
};

function mkOverrides(aclQueryResult?: string | Error) {
  const run = vi.fn();
  const written: string[] = [];
  const dirs: string[] = [];
  return {
    run,
    written,
    dirs,
    opts: {
      ...base,
      runCommand: run,
      queryAcl: vi.fn(() => {
        if (aclQueryResult instanceof Error) throw aclQueryResult;
        return aclQueryResult ?? "";
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: (p: string) => { written.push(p); },
      mkdirSync: (p: string) => { dirs.push(p); },
    },
  };
}

describe("ensureGpuSandboxAcl", () => {
  it("非 Windows / 开发版 → 跳过，不执行任何命令", () => {
    const o = mkOverrides();
    expect(ensureGpuSandboxAcl({ ...o.opts, platform: "darwin" })).toBe("skipped_platform");
    expect(ensureGpuSandboxAcl({ ...o.opts, isPackaged: false })).toBe("skipped_dev");
    expect(o.run).not.toHaveBeenCalled();
    expect(o.opts.queryAcl).not.toHaveBeenCalled();
  });

  it("哨兵文件存在 → 跳过（整个生命周期只自愈一次）", () => {
    const o = mkOverrides();
    o.opts.existsSync = vi.fn(() => true);
    expect(ensureGpuSandboxAcl(o.opts)).toBe("skipped_sentinel");
    expect(o.run).not.toHaveBeenCalled();
  });

  it("目录已有权限（icacls 显示解析名 ALL RESTRICTED APPLICATION PACKAGES）→ already_ok 写哨兵、不授权", () => {
    const o = mkOverrides("E:\\cyrene BUILTIN\\Users:(F)\nALL RESTRICTED APPLICATION PACKAGES:(RX)");
    expect(ensureGpuSandboxAcl(o.opts)).toBe("already_ok");
    expect(o.run).not.toHaveBeenCalled();
    expect(o.written).toHaveLength(1); // 哨兵已写，下次启动直接跳过
  });

  it("目录已有权限（显示裸 SID）→ already_ok（非英文/解析失败场景）", () => {
    const o = mkOverrides("E:\\cyrene *S-1-15-2-2:(OI)(CI)(RX)");
    expect(ensureGpuSandboxAcl(o.opts)).toBe("already_ok");
  });

  it("查询显示无权限 → 授权：裸 SID + (OI)(CI)(RX) + 路径引号 + /C，成功写哨兵", () => {
    const o = mkOverrides("E:\\cyrene BUILTIN\\Users:(F)"); // 无 S-1-15-2-2
    expect(ensureGpuSandboxAcl(o.opts)).toBe("granted");
    expect(o.run).toHaveBeenCalledTimes(1);
    expect(o.run.mock.calls[0][0]).toBe('icacls "E:\\cyrene" /grant *S-1-15-2-2:(OI)(CI)(RX) /C');
    expect(o.written).toHaveLength(1);
  });

  it("查询抛错（icacls 缺失等）→ 仍尝试授权", () => {
    const o = mkOverrides(new Error("command not found"));
    expect(ensureGpuSandboxAcl(o.opts)).toBe("granted");
    expect(o.run).toHaveBeenCalledTimes(1);
  });

  it("授权失败（无管理员权限）→ failed 不抛错不写哨兵（下次启动重试）", () => {
    const o = mkOverrides("");
    o.run.mockImplementation(() => { throw new Error("Access denied"); });
    expect(ensureGpuSandboxAcl(o.opts)).toBe("failed");
    expect(o.written).toHaveLength(0);
  });
});
