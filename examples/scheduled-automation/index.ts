/**
 * scheduled-automation 示例：插件调度任务所有权契约。
 *
 * 展示四个知识点：
 * 1. deps 声明 scheduler，通过 ctx.deps.scheduler 管理自有任务
 * 2. 宿主不变量：插件创建的任务一律停用落盘，必须用户在宿主界面启用，
 *    示例不提供任何"启用"或"全部工具模式"入口
 * 3. 执行规格（计划 + 提示词 + 模式 + 工具白名单）变更会撤销用户授权，
 *    更新仅改标题时不影响授权
 * 4. storage 记录任务 id 清单，配合 listTasks 对账
 */
import type { CyrenePlugin, PluginDeps, PluginTool } from "@cyrene/plugin-sdk";

let deps: PluginDeps = {};
/** 自己创建的任务 id 清单。 */
let ownTaskIds: string[] = [];

const createTool: PluginTool = {
  id: "scheduled-automation_create",
  name: "创建定时任务",
  description: "创建一个每日定时提醒任务。参数 title 为任务标题，prompt 为要执行的内容，timeOfDay 为每日触发时间（HH:mm）。创建后任务处于停用状态，需用户在宿主的定时任务面板中手动启用。",
  enabled: true,
  risk: "safe",
  effectKind: "mutation",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "任务标题" },
      prompt: { type: "string", description: "任务执行内容（提示词）" },
      timeOfDay: { type: "string", description: "每日触发时间，格式 HH:mm" },
    },
    required: ["title", "prompt", "timeOfDay"],
  },
  async execute(args) {
    const title = String(args.title ?? "").trim();
    const prompt = String(args.prompt ?? "").trim();
    const timeOfDay = String(args.timeOfDay ?? "").trim();
    if (!title || !prompt || !/^\d{2}:\d{2}$/.test(timeOfDay)) {
      return "参数不合法：title/prompt 必填，timeOfDay 须为 HH:mm 格式";
    }

    const task = await deps.scheduler!.createTask({
      title,
      prompt,
      schedule: { kind: "daily", timeOfDay },
      mode: "chat",
      // 插件任务必须显式白名单，不能使用全部工具模式
      allowedToolIds: [],
    });
    ownTaskIds.push(task.id);
    return `已创建任务「${task.title}」（${timeOfDay}，当前停用）。请在宿主的定时任务面板确认启用。`;
  },
};

const listTool: PluginTool = {
  id: "scheduled-automation_list",
  name: "列出定时任务",
  description: "列出本插件创建的全部定时任务及其启用状态与下次触发时间。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    const tasks = await deps.scheduler!.listTasks();
    if (tasks.length === 0) return "尚无任务";
    return tasks
      .map((t) => `${t.title} [${t.enabled ? "已启用" : "停用"}] 下次触发: ${t.nextFireAt ?? "无"}`)
      .join("\n");
  },
};

const updateTool: PluginTool = {
  id: "scheduled-automation_update",
  name: "更新定时任务",
  description: "更新自己创建的定时任务。参数 taskId 必填；title 只改展示名不影响授权，修改 prompt/timeOfDay 会撤销用户授权并回到停用。",
  enabled: true,
  risk: "safe",
  effectKind: "mutation",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "任务 id" },
      title: { type: "string", description: "新标题（可选）" },
      prompt: { type: "string", description: "新提示词（可选，会撤销授权）" },
      timeOfDay: { type: "string", description: "新触发时间 HH:mm（可选，会撤销授权）" },
    },
    required: ["taskId"],
  },
  async execute(args) {
    const taskId = String(args.taskId ?? "");
    if (!ownTaskIds.includes(taskId)) {
      return "只能更新本插件创建的任务";
    }
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = String(args.title);
    if (args.prompt !== undefined) patch.prompt = String(args.prompt);
    if (args.timeOfDay !== undefined) {
      patch.schedule = { kind: "daily", timeOfDay: String(args.timeOfDay) };
    }
    if (Object.keys(patch).length === 0) return "未提供任何要更新的字段";

    const task = await deps.scheduler!.updateTask(taskId, patch as never);
    return `已更新「${task.title}」；当前状态: ${task.enabled ? "已启用" : "停用"}。`;
  },
};

const deleteTool: PluginTool = {
  id: "scheduled-automation_delete",
  name: "删除定时任务",
  description: "删除自己创建的定时任务。参数 taskId 必填。",
  enabled: true,
  risk: "safe",
  effectKind: "mutation",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string", description: "任务 id" } },
    required: ["taskId"],
  },
  async execute(args) {
    const taskId = String(args.taskId ?? "");
    if (!ownTaskIds.includes(taskId)) return "只能删除本插件创建的任务";
    const ok = await deps.scheduler!.deleteTask(taskId);
    if (ok) ownTaskIds = ownTaskIds.filter((id) => id !== taskId);
    return ok ? "已删除" : "删除失败";
  },
};

const plugin: CyrenePlugin = {
  async register(ctx) {
    deps = ctx.deps;
    ownTaskIds = ctx.storage.get<string[]>("ownTaskIds") ?? [];
    ctx.onDispose(() => {
      ctx.storage.set("ownTaskIds", ownTaskIds);
    });

    for (const tool of [createTool, listTool, updateTool, deleteTool]) {
      ctx.registerTool(tool);
    }
  },
  unregister() {
    ownTaskIds = [];
  },
};

export = plugin;
