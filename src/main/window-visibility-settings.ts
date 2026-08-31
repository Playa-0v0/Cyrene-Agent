export interface WindowVisibilitySettings {
  sidebarVisible: boolean;
  tasksVisible: boolean;
}

export function normalizeWindowVisibilitySettings(input: Partial<WindowVisibilitySettings> | null | undefined): WindowVisibilitySettings {
  return {
    sidebarVisible: input?.sidebarVisible === undefined ? true : Boolean(input.sidebarVisible),
    tasksVisible: input?.tasksVisible === undefined ? true : Boolean(input.tasksVisible),
  };
}
