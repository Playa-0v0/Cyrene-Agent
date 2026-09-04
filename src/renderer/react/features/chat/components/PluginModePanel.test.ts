// @vitest-environment jsdom

import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginListEntry, PluginManagementApi } from "../../../../../shared/plugin-management";

vi.mock("../../../i18n", () => {
  const t = (key: string, values?: Record<string, string>) => {
      const labels: Record<string, string> = {
        "common.loading": "加载中…",
        "common.retry": "重试",
        "pluginPanel.title": "功能插件",
        "pluginPanel.subtitle": "管理已安装的功能插件",
        "pluginPanel.searchPlaceholder": "搜索插件名称、描述或开发者…",
        "pluginPanel.refresh": "刷新插件",
        "pluginPanel.add": "添加插件",
        "pluginPanel.emptyHint": "暂无插件",
        "pluginPanel.noMatch": "无匹配插件",
        "pluginPanel.open": "打开",
        "pluginPanel.enable": "启用",
        "pluginPanel.disable": "停用",
        "pluginPanel.delete": "删除",
        "pluginPanel.status.running": "运行中",
        "pluginPanel.status.disabled": "已停用",
        "pluginPanel.status.starting": "启动中",
        "pluginPanel.status.stopping": "停用中",
        "pluginPanel.status.failed": "启动失败",
        "pluginPanel.builtinCannotDelete": "内置插件不可删除",
      };
      if (key === "pluginPanel.developer") return `开发者：${values?.author}`;
      if (key === "pluginPanel.deleteConfirm") return `删除 ${values?.name}`;
      return labels[key] ?? key;
  };
  return { useTranslation: () => ({ t }) };
});

import { PluginModePanel, pluginToggleTarget } from "./PluginModePanel";

function plugin(overrides: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    id: "system-status",
    name: "系统状态",
    version: "0.1.0",
    description: "查询本机系统状态",
    author: "Playa",
    entry: "index.cjs",
    apiVersion: 1,
    source: "user",
    path: "C:\\plugins\\system-status",
    defaultEnabled: false,
    configuredEnabled: true,
    enabled: true,
    status: "running",
    hasUnregister: true,
    canOpen: true,
    icon: "data:image/png;base64,AA==",
    ...overrides,
  };
}

function apiFor(items: PluginListEntry[]): PluginManagementApi {
  return {
    list: vi.fn(async () => ({ plugins: items, issues: [] })),
    setEnabled: vi.fn(async () => ({ ok: true })),
    open: vi.fn(async () => ({ ok: true })),
    rescan: vi.fn(async () => ({ plugins: items, issues: [] })),
    importZip: vi.fn(async () => ({ ok: false, canceled: true })),
    uninstall: vi.fn(async () => ({ ok: true, overview: { plugins: [], issues: [] } })),
  };
}

describe("PluginModePanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows icon, plugin metadata, developer, and the three requested actions", async () => {
    const api = apiFor([plugin()]);
    await act(async () => {
      root.render(createElement(PluginModePanel, { api }));
    });

    expect(container.textContent).toContain("系统状态");
    expect(container.textContent).toContain("查询本机系统状态");
    expect(container.textContent).toContain("开发者：Playa");
    expect(container.querySelector<HTMLImageElement>(".plugin-card-ui__icon img")?.src).toContain("data:image/png");
    const cardButtons = [...container.querySelectorAll<HTMLButtonElement>(".plugin-card-ui__actions button")];
    expect(cardButtons.map((button) => button.textContent)).toEqual(["打开", "停用", "删除"]);
  });

  it("enables a disabled plugin and refreshes its state", async () => {
    const disabledPlugin = plugin({ configuredEnabled: false, enabled: false, status: "disabled" });
    const api = apiFor([disabledPlugin]);
    await act(async () => {
      root.render(createElement(PluginModePanel, { api }));
    });
    const enable = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "启用");
    expect(enable).toBeDefined();

    await act(async () => enable?.click());

    expect(api.setEnabled).toHaveBeenCalledWith("system-status", true);
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("keeps delete disabled for built-in plugins", async () => {
    const api = apiFor([plugin({ source: "builtin" })]);
    await act(async () => {
      root.render(createElement(PluginModePanel, { api }));
    });

    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "删除");
    expect(deleteButton?.disabled).toBe(true);
    expect(deleteButton?.title).toBe("内置插件不可删除");
  });
});

describe("pluginToggleTarget", () => {
  it("retries failed plugins and disables running plugins", () => {
    expect(pluginToggleTarget(plugin({ status: "failed" }))).toBe(true);
    expect(pluginToggleTarget(plugin({ status: "running" }))).toBe(false);
  });
});
