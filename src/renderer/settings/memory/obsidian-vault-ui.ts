// Obsidian Vault 绑定 UI 逻辑
// 从 settings.ts 抽离。包含刷新 + 4 个按钮/开关事件。
// 在 settings.ts 顶层调用 initObsidianVaultUI() 一次性挂载。

import {
  obsidianVaultBindBtn,
  obsidianVaultUnbound,
  obsidianVaultBound,
  obsidianVaultPath,
  obsidianVaultSyncBtn,
  obsidianVaultUnbindBtn,
  obsidianVaultAutoSync,
  obsidianVaultHint,
} from "./dom";

async function refreshObsidianVaultUI(): Promise<void> {
  const api = window.memoryPanel;
  if (!api) return;
  try {
    const config = await api.getVaultConfig();
    if (config.vaultPath) {
      // 已绑定
      obsidianVaultUnbound?.classList.add("is-hidden");
      obsidianVaultBound?.classList.remove("is-hidden");
      if (obsidianVaultPath) obsidianVaultPath.textContent = `绑定路径：${config.vaultPath}`;
      if (obsidianVaultAutoSync) obsidianVaultAutoSync.checked = config.autoSync;
      if (config.lastSyncAt > 0 && obsidianVaultHint) {
        obsidianVaultHint.textContent = `上次同步：${new Date(config.lastSyncAt).toLocaleString()}`;
      }
    } else {
      // 未绑定
      obsidianVaultUnbound?.classList.remove("is-hidden");
      obsidianVaultBound?.classList.add("is-hidden");
    }
  } catch {
    // 读取配置失败，忽略
  }
}

/** 挂载 Obsidian Vault 绑定相关的事件并刷新一次 UI。 */
export function initObsidianVaultUI(): void {
  void refreshObsidianVaultUI();

  obsidianVaultBindBtn?.addEventListener("click", async () => {
    const api = window.memoryPanel;
    if (!api) return;
    const btn = obsidianVaultBindBtn;
    if (!btn) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "绑定中...";
    if (obsidianVaultHint) obsidianVaultHint.textContent = "";
    try {
      const result = await api.bindVault();
      if (result.ok) {
        if (obsidianVaultHint) obsidianVaultHint.textContent = `已绑定并同步 ${result.fileCount} 个文件`;
      } else if (!result.canceled) {
        if (obsidianVaultHint) obsidianVaultHint.textContent = `绑定失败：${result.error}`;
      }
      await refreshObsidianVaultUI();
    } catch (err) {
      if (obsidianVaultHint) obsidianVaultHint.textContent = `绑定失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  obsidianVaultSyncBtn?.addEventListener("click", async () => {
    const api = window.memoryPanel;
    if (!api) return;
    const btn = obsidianVaultSyncBtn;
    if (!btn) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "同步中...";
    if (obsidianVaultHint) obsidianVaultHint.textContent = "";
    try {
      const result = await api.syncNow();
      if (result.ok) {
        if (obsidianVaultHint) obsidianVaultHint.textContent = `已同步 ${result.fileCount} 个文件 · ${new Date().toLocaleString()}`;
      } else {
        if (obsidianVaultHint) obsidianVaultHint.textContent = `同步失败：${result.error}`;
      }
    } catch (err) {
      if (obsidianVaultHint) obsidianVaultHint.textContent = `同步失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  obsidianVaultUnbindBtn?.addEventListener("click", async () => {
    const api = window.memoryPanel;
    if (!api) return;
    await api.unbindVault();
    if (obsidianVaultHint) obsidianVaultHint.textContent = "已解绑（vault 文件夹里的 md 不会被删除）";
    await refreshObsidianVaultUI();
  });

  obsidianVaultAutoSync?.addEventListener("change", async () => {
    const api = window.memoryPanel;
    if (!api) return;
    await api.setAutoSync(obsidianVaultAutoSync.checked);
    if (obsidianVaultHint) obsidianVaultHint.textContent = obsidianVaultAutoSync.checked ? "已开启自动同步" : "已关闭自动同步";
  });
}
