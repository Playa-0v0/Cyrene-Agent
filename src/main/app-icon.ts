import * as path from "path";
import { UI_ICON_PRESETS, type UiIcon } from "../shared/ui-icon";

export function getAppIconPath(icon: UiIcon): string {
  const preset = UI_ICON_PRESETS.find((item) => item.id === icon);
  return path.join(__dirname, "..", "..", "..", "assets", "icon-presets", preset?.fileName ?? "cyrene-sun.png");
}
