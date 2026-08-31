// 权限档位 UI：read-only / scoped / per-action / full 四档切换
// 从 settings.ts 抽离。依赖 plugins DOM 引用 + shared modal。
// 副作用导入：模块加载时执行事件绑定 + 初始加载档位。

import { permissionBlocksWrap, permissionNote } from "./dom";
import { _initModalOverlay } from "../shared/modal";
import { modalState } from "../shared/modal-state";

type PermissionLevel = "project-read-only" | "read-only" | "scoped" | "per-action" | "full";

const PERMISSION_NOTES: Record<PermissionLevel, string> = {
  "project-read-only": "完全只读：昔涟只能在当前项目目录内只读，不能修改任何文件，也不能执行命令。",
  "read-only": "只读：昔涟不会修改本地任何文件，也不能为你安装新工具。",
  "scoped": "指定目录：昔涟只能在你授权的目录里读写文件（白名单后续在此面板配置）。",
  "per-action": "每次审批：每次涉及文件或安装的操作，昔涟都会在聊天里弹卡片让你确认。",
  "full": "完全访问：昔涟可以自由调用本地命令（含 git/npm/pip）。请只在你完全信任的情况下使用。",
};

function paintPermissionUI(level: PermissionLevel): void {
  if (!permissionBlocksWrap) return;
  // scoped 档已从插件面板移除，回退显示只读
  const display = level === "scoped" ? "read-only" : level;
  const blocks = permissionBlocksWrap.querySelectorAll<HTMLButtonElement>("button[data-level]");
  blocks.forEach((b) => {
    const isActive = b.dataset.level === display;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });
  if (permissionNote) {
    permissionNote.textContent = PERMISSION_NOTES[level];
  }
}

async function confirmFullAccess(): Promise<boolean> {
  // 完全访问需要延迟确认 + 风险提示
  _initModalOverlay();
  if (!modalState.cyOverlay) return false;
  const iconEl = modalState.cyOverlay.querySelector("#cy-modal-icon") as HTMLElement;
  const titleEl = modalState.cyOverlay.querySelector("#cy-modal-title") as HTMLElement;
  const msgEl = modalState.cyOverlay.querySelector("#cy-modal-message") as HTMLElement;
  const cancelBtn = modalState.cyOverlay.querySelector("#cy-modal-cancel") as HTMLButtonElement;
  const confirmBtn = modalState.cyOverlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;
  iconEl.textContent = "⚠️";
  titleEl.textContent = "切换到完全访问？";
  msgEl.textContent = "这意味着昔涟可以在你的电脑上自由执行命令，包括 git clone、npm install、删除文件等。请只在你完全信任她的判断时启用。";
  cancelBtn.textContent = "再想想";
  modalState.cyOverlay.classList.remove("is-hidden");

  // 倒计时 5 秒强制等待
  let remain = 5;
  confirmBtn.disabled = true;
  confirmBtn.textContent = "我了解风险（" + remain + "）";
  const tick = setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "我了解风险，启用";
      clearInterval(tick);
    } else {
      confirmBtn.textContent = "我了解风险（" + remain + "）";
    }
  }, 1000);

  return new Promise((resolve) => {
    const cleanup = (result: boolean) => {
      clearInterval(tick);
      confirmBtn.disabled = false;
      modalState.cyOverlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve(result);
    };
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

// 事件绑定（模块加载时执行）
if (permissionBlocksWrap) {
  permissionBlocksWrap.addEventListener("click", async (event) => {
    const btn = (event.target as HTMLElement)?.closest("button[data-level]") as HTMLButtonElement | null;
    if (!btn) return;
    const target = (btn.dataset.level || "") as PermissionLevel;
    if (!target) return;
    if (btn.classList.contains("is-active")) {
      console.log("[settings] 档位未变，不动作");
      return;
    }

    if (target === "full") {
      const ok = await confirmFullAccess();
      if (!ok) {
        console.log("[settings] 用户取消了完全访问");
        return;
      }
    }

    console.log("[settings] 切换权限档位 →", target);
    try {
      const result = await window.settings?.setPermissionLevel?.(target);
      if (result?.ok) {
        paintPermissionUI((result.level || target) as PermissionLevel);
      } else {
        console.warn("[settings] 切换档位失败:", result?.error);
      }
    } catch (err) {
      console.error("[settings] 切换档位异常:", err);
    }
  });

  // 初始化：从后端拿当前档位
  void (async () => {
    try {
      const result = await window.settings?.getPermissionLevel?.();
      const level = (result?.level || "read-only") as PermissionLevel;
      console.log("[settings] 当前权限档位:", level);
      paintPermissionUI(level);
    } catch (err) {
      console.warn("[settings] 加载权限档位失败:", err);
      paintPermissionUI("read-only");
    }
  })();
}
