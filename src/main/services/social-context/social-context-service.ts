import path from "node:path";
import { app } from "electron";
import { loadModelSettings } from "../../settings/model-settings";
import { getAdapterForConfig } from "../../orchestrator/vendors";
import type { StructuredOutputRequest, VendorConfig } from "../../orchestrator/vendors";
import {
  classifyStructuredOutputEndpoint,
  resolveStructuredOutputProfile,
} from "../../orchestrator/structured-output/profiles";
import { normalizeFinishReason } from "../../orchestrator/structured-output/finish-reason";
import {
  buildSocialExtractionPrompt,
  SOCIAL_EXTRACTION_SCHEMA,
} from "../../social-context/extractor";
import { createSocialContextScheduler } from "../../social-context/scheduler";
import { createSocialAtomStore } from "../../social-context/store";
import type { LlmClient } from "../llm/llm-client";

export interface SocialContextService {
  store: ReturnType<typeof createSocialAtomStore>;
  scheduler: ReturnType<typeof createSocialContextScheduler>;
}

export interface SocialContextServiceDeps {
  llmClient: LlmClient;
  enqueueLLMTask: (
    label: string,
    task: () => Promise<void>,
    options: { log: boolean; retryRateLimit: boolean },
  ) => Promise<unknown>;
}

export function createSocialContextService(deps: SocialContextServiceDeps): SocialContextService {
  const store = createSocialAtomStore(path.join(app.getPath("userData"), "chat-social-atoms.json"));

  const scheduler = createSocialContextScheduler({
    store,
    enqueue: (label, task) =>
      deps.enqueueLLMTask(label, task, {
        log: false,
        retryRateLimit: false,
      }),
    generate: async (input, repair) => {
      const settings = loadModelSettings();
      const config: VendorConfig = {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        explicitTransport: settings.explicitTransport,
        reasoning: { mode: "off" },
      };
      const adapter = getAdapterForConfig(config);
      const profile = resolveStructuredOutputProfile({
        provider: adapter.id,
        model: config.model,
        transport: adapter.transport,
        endpointKind: classifyStructuredOutputEndpoint({
          providerId: adapter.id,
          configuredBaseUrl: config.baseUrl,
          officialBaseUrl: adapter.capability.baseUrl,
        }),
      });
      const structuredOutput: StructuredOutputRequest =
        profile.mode === "provider_json_schema"
          ? {
              mode: "json_schema",
              name: "chat_social_atoms",
              schema: SOCIAL_EXTRACTION_SCHEMA,
              strict: true,
            }
          : profile.mode === "provider_json_object"
            ? {
                mode: "json_object",
                name: "chat_social_atoms",
                schema: SOCIAL_EXTRACTION_SCHEMA,
              }
            : {
                mode: "prompt_json",
                name: "chat_social_atoms",
                schema: SOCIAL_EXTRACTION_SCHEMA,
                sendJsonObjectHint: profile.requestHints.sendJsonObject,
              };
      const response = await deps.llmClient.chatNonStream(
        settings,
        [
          {
            role: "system",
            content:
              "Extract only directly supported chat continuity facts. Return exactly one JSON object and no prose.",
          },
          { role: "user", content: buildSocialExtractionPrompt(input, repair) },
        ],
        settings.model.match(/^kimi-k2\.6(?:$|-)/i) ? undefined : 0,
        12_000,
        "Chat social context extraction",
        { mode: "off" },
        {
          structuredOutput,
          maxTokens: 1_000,
          ...(profile.requestHints.reasoningSplit ? { extraBody: { reasoning_split: true } } : {}),
        },
      );
      if (response.refusal || normalizeFinishReason(response.finishReason) !== "complete") {
        throw new Error("CHAT_SOCIAL_EXTRACTION_INCOMPLETE");
      }
      return response.text;
    },
    recordMetric: (metric) => {
      console.log(
        `[ChatSocialContext] outcome=${metric.outcome} accepted=${metric.acceptedCount} rejected=${metric.rejectedCount} attempts=${metric.attempts} repairs=${metric.repairCount}`,
      );
    },
  });

  return { store, scheduler };
}
