import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings } from "../settings/model-settings";
import type { GeneralSettings } from "../settings/general-settings";
import { registerEmailTools } from "./email-tools";
import { registerDocumentTools } from "./document-tools";
// fs-tools / built-in-tools 仍依赖模块加载副作用，先集中在此，后续可继续显式化
import "./fs-tools";
import { registerLifeTools, setTranslateConfig } from "./life-tools";
import { registerRecallHistoryTool } from "./history-tools";
import { registerSearchCodeTool, registerSearchTextTool } from "./search-code-tools";
import { registerApplyPatchTool } from "./apply-patch-tools";
import { registerAstGrepTools } from "./ast-grep-tools";
import { toolRegistry } from "./tool-registry";
import { registerTravelTools } from "./travel-tools";
import type { GitService } from "../code-git/git-service";
import { registerCodeGitTools } from "./git-tools";
import type { LspManager } from "../lsp/manager";
import { registerLspTool } from "./lsp-tool";
import "./built-in-tools";

export function syncBuiltInToolToggles(settings: GeneralSettings): void {
  toolRegistry.setEnabled("weather", settings.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", settings.travelEnabled);
}

export function registerAllTools(deps: { codeGitService: GitService; lspManager: LspManager }): void {
  registerCodeGitTools(deps.codeGitService, toolRegistry);
  registerLspTool(deps.lspManager, toolRegistry);
  registerSearchCodeTool();
  registerSearchTextTool();
  registerApplyPatchTool();
  registerAstGrepTools();
  registerRecallHistoryTool();
  registerDocumentTools();

  setTranslateConfig(() => {
    const s = loadModelSettings();
    return s.apiKey
      ? { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, explicitTransport: s.explicitTransport }
      : null;
  });
  registerLifeTools();

  registerTravelTools();
  registerEmailTools();

  syncBuiltInToolToggles(loadGeneralSettings());
}
