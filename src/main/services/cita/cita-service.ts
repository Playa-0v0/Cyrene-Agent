import { CitaService, ContextStore, RemoteSemanticEngine } from "../../cita";
import { loadGeneralSettings } from "../../settings/settings-facade";
import { loadModelSettings } from "../../settings/model-settings";
import { getAdapterForConfig } from "../../orchestrator/vendors";
import type { VendorConfig } from "../../orchestrator/vendors";
import {
  classifyStructuredOutputEndpoint,
  resolveStructuredOutputProfile,
} from "../../orchestrator/structured-output/profiles";
import { loadPromptFile } from "../../prompts/prompt-loader";
import { normalizeCitaSettings } from "../../cita/settings";
import type { LlmClient } from "../llm/llm-client";

export interface CitaServiceDeps {
  llmClient: LlmClient;
}

export function createCitaService(deps: CitaServiceDeps): CitaService {
  return new CitaService({
    store: new ContextStore(),
    engine: new RemoteSemanticEngine(
      async (request, signal) => {
        const settings = loadModelSettings();
        // Kimi k2.6 只允许特定 temperature（0.6），传 0 会被拒。
        // 省略让服务端用默认值，其他模型继续 temperature=0 保证确定性。
        const citaTemp = settings.model.match(/^kimi-k2\.6(?:$|-)/i) ? undefined : 0;
        return deps.llmClient.chatNonStream(
          settings,
          [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPrompt },
          ],
          citaTemp,
          6_000,
          "CITA understandTurn",
          { mode: "off" as const },
          {
            structuredOutput: request.structuredOutput,
            maxTokens: request.maxTokens,
            extraBody: request.extraBody,
          },
          signal,
        );
      },
      {
        timeoutMs: 8_000,
        systemPrompt: loadPromptFile("cita_system.md"),
        getProfile: () => {
          const settings = loadModelSettings();
          const cfg: VendorConfig = {
            provider: settings.provider,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey: settings.apiKey,
            explicitTransport: settings.explicitTransport,
            reasoning: { mode: "off" },
          };
          const adapter = getAdapterForConfig(cfg);
          return resolveStructuredOutputProfile({
            provider: adapter.id,
            model: cfg.model,
            transport: adapter.transport,
            endpointKind: classifyStructuredOutputEndpoint({
              providerId: adapter.id,
              configuredBaseUrl: cfg.baseUrl,
              officialBaseUrl: adapter.capability.baseUrl,
            }),
          });
        },
      },
    ),
    getSettings: () =>
      normalizeCitaSettings({
        enabled: loadGeneralSettings().citaEnabled,
        semanticEngine: loadGeneralSettings().citaSemanticEngine,
      }),
  });
}
