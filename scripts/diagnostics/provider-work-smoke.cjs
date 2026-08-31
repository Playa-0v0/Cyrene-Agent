const fs = require("fs");
const path = require("path");

// Reusable live provider smoke test.
// Usage: node scripts/diagnostics/provider-work-smoke.cjs [runs] [model] [delayBetweenRunsMs]
// Reads the locally saved API configuration and never prints the API key.
// Reports task execution success separately from fail-closed routing to Soul.

const root = path.resolve(__dirname, "..", "..");
const { CitaService } = require(path.join(root, "dist/main/main/cita/cita-service.js"));
const { ContextStore } = require(path.join(root, "dist/main/main/cita/context-store.js"));
const { RemoteSemanticEngine } = require(path.join(root, "dist/main/main/cita/remote-semantic-engine.js"));
const {
  runLangGraphAgentLoop,
} = require(path.join(root, "dist/main/main/orchestrator/langgraph-agent-loop.js"));
const {
  classifyStructuredOutputEndpoint,
  resolveStructuredOutputProfile,
} = require(path.join(root, "dist/main/main/orchestrator/structured-output/profiles.js"));
const {
  getAdapterForConfig,
} = require(path.join(root, "dist/main/main/orchestrator/vendors/index.js"));
const {
  contextRefRegistry,
} = require(path.join(root, "dist/main/main/orchestrator/tool-context.js"));

const runCount = Math.max(1, Number(process.argv[2] || 10));
const modelOverride = String(process.argv[3] || "").trim();
const delayBetweenRunsMs = Math.max(0, Number(process.argv[4] || 0));
const settingsPath = path.join(process.env.APPDATA, "live2d-cyrene", "model-settings.json");
const savedSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
if (!savedSettings.apiKey) throw new Error("LOCAL_API_KEY_MISSING");
const config = {
  ...savedSettings,
  ...(modelOverride ? { model: modelOverride } : {}),
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
const workGraphTimeoutMs = Math.max(
  35_000,
  profile.repair.cita.totalBudgetMs
    + profile.repair.action_gate.totalBudgetMs
    + 45_000,
);

const fixedNow = Date.parse("2026-07-24T03:00:00.000Z");
const conversationId = "provider-work-smoke";
const query = "把刚才那个项目的优先级设置为高。";
contextRefRegistry.clear(conversationId);
const contextRef = contextRefRegistry.issue({
  conversationId,
  domain: "project",
  kind: "project",
  expiresAt: Date.now() + 60 * 60 * 1_000,
  value: { projectName: "Alpha", priority: "medium" },
});

const citaSystemPrompt = fs.readFileSync(path.join(root, "prompts", "cita_system.md"), "utf8");
const actionGateSystemPrompt = fs.readFileSync(path.join(root, "prompts", "action_gate_system.md"), "utf8");
const nativeFcSystemPrompt = fs.readFileSync(path.join(root, "prompts", "native_fc_system.md"), "utf8");
const tool = {
  id: "work_test_set_priority",
  name: "设置项目优先级（测试）",
  description: "设置已展示项目的优先级。必须使用已验证项目引用；这是无副作用测试工具。",
  catalogHint: "设置已展示项目优先级，必须使用可信项目引用。",
  capability: "project.priority.set",
  controlledInput: { projectRef: "context_ref" },
  enabled: true,
  risk: "safe",
  inputSchema: {
    type: "object",
    properties: {
      projectRef: { type: "string", description: "已验证的项目引用" },
      priority: { type: "string", enum: ["low", "medium", "high"], description: "目标优先级" },
    },
    required: ["projectRef", "priority"],
  },
  execute: async () => {
    throw new Error("DIRECT_TOOL_EXECUTION_NOT_EXPECTED");
  },
};

const capturedMetrics = [];
const originalLog = console.log;
const originalWarn = console.warn;
console.log = (...args) => {
  const first = String(args[0] || "");
  if (first.startsWith("[StructuredOutput] ")) {
    try {
      capturedMetrics.push(JSON.parse(first.slice("[StructuredOutput] ".length)));
    } catch {
      // Diagnostic collection must not affect the Work path.
    }
    return;
  }
  if (
    first.startsWith("[CITA/Trace]")
    || first.startsWith("[AgentGraph/Trace]")
    || first.startsWith("[Perf]")
  ) return;
  originalLog(...args);
};
console.warn = (...args) => {
  const first = String(args[0] || "");
  if (first.startsWith("[AgentGraph/Trace]") || first.startsWith("[CITA/Trace]")) return;
  originalWarn(...args);
};

async function invokeChat(request, signal) {
  const http = adapter.buildRequest(request, config);
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP_${response.status}_${body.slice(0, 160)}`);
  }
  return adapter.parseResponse(await response.json());
}

function redact(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replaceAll(config.apiKey, "[REDACTED]").slice(0, 500);
}

function trustedRefsFrom(contextPackage) {
  if (!contextPackage) return [];
  return [...new Set([
    ...contextPackage.resolvedReferences.map((item) => item.targetRef),
    ...(contextPackage.focusedContexts ?? []).map((item) => item.contextRef),
    ...(contextPackage.supportingContexts ?? []).map((item) => item.contextRef),
  ])];
}

async function prepareCita() {
  const engine = new RemoteSemanticEngine(
    async (request, signal) => {
      const generated = await invokeChat({
        model: config.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        stream: false,
        maxTokens: request.maxTokens,
        structuredOutput: request.structuredOutput,
        extraBody: request.extraBody,
      }, signal);
      return {
        text: generated.text,
        thinking: generated.thinking,
        finishReason: generated.finishReason,
        refusal: generated.refusal,
      };
    },
    {
      timeoutMs: profile.repair.cita.totalBudgetMs,
      maxTokens: 1_200,
      systemPrompt: citaSystemPrompt,
      profile,
    },
  );
  const store = new ContextStore({ now: () => fixedNow });
  const cita = new CitaService({
    store,
    engine,
    getSettings: () => ({ enabled: true, semanticEngine: "remote" }),
    now: () => fixedNow,
  });
  cita.ingest({
    type: "context_upserted",
    eventId: "event-project-alpha",
    conversationId,
    occurredAt: fixedNow - 1_000,
    source: "provider-work-smoke",
    context: {
      contextRef,
      conversationId,
      domain: "project",
      kind: "project",
      label: "项目 Alpha",
      attributes: { priority: "medium" },
      position: 1,
      presented: true,
      lifecycle: "active",
      source: "ui_event",
    },
  });
  return cita.prepareTurn({
    conversationId,
    turnId: "turn-fixed",
    originalQuery: query,
    recentDialogue: [
      { role: "assistant", text: "这是项目 Alpha，目前优先级为中。" },
      { role: "user", text: query },
    ],
  });
}

async function runOnce(run) {
  const startedAt = Date.now();
  const metricStart = capturedMetrics.length;
  let toolExecutionCount = 0;
  const events = [];
  const result = {
    run,
    soulReached: false,
    functionalSuccess: false,
    cita: null,
    actionGate: null,
    nativeFc: null,
    toolRuntime: null,
    soul: null,
    latencyMs: 0,
  };
  try {
    let prepared;
    try {
      prepared = await prepareCita();
    } catch (error) {
      // Matches build-options.ts: a CITA exception falls back to the original query.
      prepared = { contextBlock: "", contextPackage: undefined };
      result.citaException = redact(error);
    }
    const contextualizedQuery = prepared.contextPackage?.contextualizedQuery ?? query;
    const citaRefs = prepared.contextPackage?.resolvedReferences.map((item) => item.targetRef) ?? [];
    result.cita = {
      status: prepared.contextPackage?.semanticStatus ?? "exception_fallback",
      rewriteStatus: prepared.contextPackage?.rewriteStatus ?? "unchanged",
      refs: citaRefs,
    };

    const graph = await runLangGraphAgentLoop({
      settings: config,
      adapter,
      messages: [
        { role: "assistant", content: "这是项目 Alpha，目前优先级为中。" },
        { role: "user", content: query },
      ],
      cleanMessages: [
        { role: "assistant", content: "这是项目 Alpha，目前优先级为中。" },
        { role: "user", content: query },
      ],
      tools: [tool],
      toolSystemContent: "",
      soulSystemBaseContent: [
        "你是 Work 流程测试的 Soul。",
        "如果前置阶段失败，只根据本地可信失败事实诚实说明，不得声称工具已执行。",
        "如果工具成功，只根据 TOOL_EXECUTION_CONTEXT 简短说明结果。",
        "不要调用工具，不要输出工具协议。",
      ].join("\n"),
      originalQuery: query,
      contextualizedQuery,
      citaContextBlock: prepared.contextBlock,
      trustedRefs: trustedRefsFrom(prepared.contextPackage),
      timeoutMs: workGraphTimeoutMs,
      maxIterations: 4,
      executeTool: async (toolCall, runnableToolIds) => {
        if (!runnableToolIds.has(toolCall.name)) throw new Error("TEST_TOOL_NOT_RUNNABLE");
        const args = JSON.parse(toolCall.arguments);
        toolExecutionCount += 1;
        return {
          status: "succeeded",
          terminal: true,
          retryable: false,
          output: JSON.stringify({
            ok: true,
            projectRef: args.projectRef,
            priority: args.priority,
            effect: { state: "completed" },
          }),
        };
      },
      actionGateSystemPrompt,
      nativeFcSystemContent: nativeFcSystemPrompt,
      responseContext: `用户实际问题：${contextualizedQuery}`,
      conversationId,
      onEvent: (event) => events.push(event),
      recordUsage: () => {},
    });

    const toolResult = graph.toolResults.at(-1);
    const metrics = capturedMetrics.slice(metricStart);
    const citaMetric = metrics.find((metric) => metric.stage === "cita");
    const actionMetric = metrics.find((metric) => metric.stage === "action_gate");
    result.cita = {
      ...result.cita,
      attempts: citaMetric?.attempts ?? null,
      repairs: citaMetric?.repairCount ?? null,
      outcome: citaMetric?.finalOutcome ?? (result.citaException ? "failure" : "missing"),
      failureCode: citaMetric?.validationFailureCode ?? null,
    };
    result.actionGate = {
      attempts: actionMetric?.attempts ?? null,
      repairs: actionMetric?.repairCount ?? null,
      outcome: actionMetric?.finalOutcome ?? "missing",
      failureCode: actionMetric?.validationFailureCode ?? null,
    };
    result.nativeFc = {
      args: toolResult?.args ?? null,
      preRuntimeFailure: toolResult?.toolExecuted === false,
    };
    result.toolRuntime = {
      executions: toolExecutionCount,
      status: toolResult?.status ?? "not_run",
      terminal: toolResult?.terminal ?? null,
    };
    result.soul = {
      replyLength: graph.reply.length,
      emittedText: events.some((event) => event.type === "text_message_content"),
    };
    result.soulReached = Boolean(graph.reply.trim()) && result.soul.emittedText;
    result.functionalSuccess = (
      actionMetric?.finalOutcome === "success"
      && toolExecutionCount === 1
      && toolResult?.status === "succeeded"
      && toolResult.args.projectRef === contextRef
      && toolResult.args.priority === "high"
    );
  } catch (error) {
    result.error = redact(error);
  } finally {
    result.latencyMs = Date.now() - startedAt;
  }
  return result;
}

(async () => {
  const results = [];
  for (let run = 1; run <= runCount; run += 1) {
    if (run > 1 && delayBetweenRunsMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayBetweenRunsMs));
    }
    const result = await runOnce(run);
    results.push(result);
    originalLog(`PROGRESS ${run}/${runCount} ${JSON.stringify(result)}`);
  }
  console.log = originalLog;
  console.warn = originalWarn;
  const latencies = results.map((item) => item.latencyMs);
  originalLog(`FINAL ${JSON.stringify({
    provider: adapter.id,
    model: config.model,
    profile: profile.id,
    tier: profile.tier,
    mode: profile.mode,
    configuredBaseUrl: config.baseUrl,
    fixedInput: {
      query,
      contextRef,
      capability: tool.capability,
      expectedArgs: { projectRef: contextRef, priority: "high" },
    },
    summary: {
      total: results.length,
      soulReached: results.filter((item) => item.soulReached).length,
      soulMissed: results.filter((item) => !item.soulReached).length,
      functionalSuccess: results.filter((item) => item.functionalSuccess).length,
      functionalFailure: results.filter((item) => !item.functionalSuccess).length,
      latencyMs: {
        total: latencies.reduce((sum, value) => sum + value, 0),
        min: Math.min(...latencies),
        max: Math.max(...latencies),
      },
    },
    results,
  })}`);
})().catch((error) => {
  console.log = originalLog;
  console.warn = originalWarn;
  originalLog(`FATAL ${JSON.stringify({ error: redact(error) })}`);
  process.exitCode = 1;
});
