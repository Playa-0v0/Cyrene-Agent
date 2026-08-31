import { logger, LogTag } from "../logger";
import {
  initPermissionFromDisk,
  registerPermissionIpc,
  getCurrentLevel,
} from "../permission";
import { registerChoiceIpc } from "../user-choice";

/**
 * 启动权限子系统：从磁盘加载权限配置、注册 IPC、记录当前档位。
 *
 * 注意：必须在 createWindow 之后、任意工具调用之前调用。
 */
export function bootstrapPermission(): void {
  initPermissionFromDisk();
  registerPermissionIpc();
  registerChoiceIpc();
  logger.info(LogTag.Cyrene, "当前 agent 权限档位:", getCurrentLevel());
}
