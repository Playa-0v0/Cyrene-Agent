import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { findPromptPath } from "./external-content-paths";

export function getCustomStylePromptPath(): string {
  return path.join(app.getPath("userData"), "styles", "custom", "custom.md");
}

export function ensureCustomStylePrompt(): string {
  const targetPath = getCustomStylePromptPath();
  if (fs.existsSync(targetPath)) return targetPath;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const templatePath = findPromptPath("styles/custom/custom.md");
  if (templatePath) {
    fs.copyFileSync(templatePath, targetPath);
  } else {
    fs.writeFileSync(targetPath, "", "utf8");
  }
  return targetPath;
}
