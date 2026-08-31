import { describe, expect, it, vi } from "vitest";
import {
  bootstrapReactSession,
  normalizeSessionMode,
  openSessionByIdWithDeps,
} from "./openSessionByDeps";

describe("bootstrapReactSession", () => {
  it("opens the URL session and refreshes its list without selecting again", async () => {
    const openSession = vi.fn(async () => true);
    const refreshSessions = vi.fn(async () => {});

    await bootstrapReactSession({
      urlSessionId: "work-1",
      currentMode: "work",
      openSession,
      refreshSessions,
    });

    expect(openSession).toHaveBeenCalledWith("work-1");
    expect(refreshSessions).toHaveBeenCalledWith("work", false);
  });

  it("falls back to selecting from the current mode when the URL session is invalid", async () => {
    const refreshSessions = vi.fn(async () => {});

    await bootstrapReactSession({
      urlSessionId: "missing",
      currentMode: "work",
      openSession: async () => false,
      refreshSessions,
    });

    expect(refreshSessions).toHaveBeenCalledWith("work", true);
  });

  it("refreshes and selects immediately when there is no URL session", async () => {
    const openSession = vi.fn(async () => true);
    const refreshSessions = vi.fn(async () => {});

    await bootstrapReactSession({
      urlSessionId: null,
      currentMode: "work",
      openSession,
      refreshSessions,
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(refreshSessions).toHaveBeenCalledWith("work", true);
  });

  it("uses the real fallback refresh when opening throws", async () => {
    const refreshSessions = vi.fn(async () => {});

    await bootstrapReactSession({
      urlSessionId: "broken",
      currentMode: "work",
      openSession: async () => {
        throw new Error("read failed");
      },
      refreshSessions,
    });

    expect(refreshSessions).toHaveBeenCalledWith("work", true);
  });
});

describe("normalizeSessionMode", () => {
  it("合法 mode 各自归一化", () => {
    expect(normalizeSessionMode("chat")).toBe("chat");
    expect(normalizeSessionMode("work")).toBe("work");
    expect(normalizeSessionMode("code")).toBe("code");
    expect(normalizeSessionMode("daily")).toBe("work");
  });

  it("'learn' 返回 'learn'", () => {
    expect(normalizeSessionMode("learn")).toBe("learn");
  });

  it("undefined / 未知 / 空串都返回 null", () => {
    expect(normalizeSessionMode(undefined)).toBeNull();
    expect(normalizeSessionMode("")).toBeNull();
    expect(normalizeSessionMode("foo")).toBeNull();
  });
});

describe("openSessionByIdWithDeps", () => {
  it("code 会话：selectSession(id, 'code') 被调用，返回 true", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "code-1",
      getSession: async () => ({ mode: "code" }),
      selectSession,
    });
    expect(result).toBe(true);
    expect(selectSession).toHaveBeenCalledWith("code-1", "code");
  });

  it("work 会话：selectSession(id, 'work') 被调用", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "work-1",
      getSession: async () => ({ mode: "work" }),
      selectSession,
    });
    expect(result).toBe(true);
    expect(selectSession).toHaveBeenCalledWith("work-1", "work");
  });

  it("历史 daily 会话：按 Work 打开", async () => {
    const selectSession = vi.fn(async () => {});
    await openSessionByIdWithDeps({
      sessionId: "daily-1",
      getSession: async () => ({ mode: "daily" }),
      selectSession,
    });
    expect(selectSession).toHaveBeenCalledWith("daily-1", "work");
  });

  it("learn 会话：selectSession(id, 'learn') 被调用，返回 true", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "learn-1",
      getSession: async () => ({ mode: "learn" }),
      selectSession,
    });
    expect(result).toBe(true);
    expect(selectSession).toHaveBeenCalledWith("learn-1", "learn");
  });

  it("unknown / missing mode：selectSession 不被调用，返回 false", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "x-1",
      getSession: async () => ({}), // mode 缺失
      selectSession,
    });
    expect(result).toBe(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("会话不存在：selectSession 不被调用，返回 false", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "ghost",
      getSession: async () => null,
      selectSession,
    });
    expect(result).toBe(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("getSession reject：异常向上抛", async () => {
    const selectSession = vi.fn(async () => {});
    await expect(
      openSessionByIdWithDeps({
        sessionId: "x",
        getSession: async () => {
          throw new Error("disk full");
        },
        selectSession,
      }),
    ).rejects.toThrow("disk full");
    expect(selectSession).not.toHaveBeenCalled();
  });
});
