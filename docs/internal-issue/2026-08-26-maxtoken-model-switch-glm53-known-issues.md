# 长任务截断 / 欢迎页切模型 / GLM-5.3 正则失配 已知问题（2026-08-26 调研）

> 范围：Harness LLM 调用层（`harness-llm.ts` / `types.ts`）、渲染层会话管理（`ChatPage.tsx`）、
> 厂商能力正则表（`shared/reasoning.ts` / `vendors/style-sampling.ts` / `structured-output/profiles.ts`）。
> 三者均为静态代码走读确认，未写复现测试；与 2026-08-25 的并行调度问题相互独立。

## 修复状态

| 问题 | 状态 | 修复 commit |
| --- | --- | --- |
| 1 Harness 输出上限硬编码 8192 且截断静默 | 已修复（2026-08-26，待 commit） | — |
| 2 欢迎页（无会话）切模型被静默丢弃 | 已修复（2026-08-26，待 commit） | — |
| 3 GLM-5.3 未纳入模型能力正则表（4 处） | 已修复（2026-08-26，待 commit） | — |

### 修复实施记录（2026-08-26）

**问题 3（批次 1）**：`shared/reasoning.ts` 正则改为 `/^glm-5\.[23]/i`；
`vendors/style-sampling.ts` 与 `structured-output/profiles.ts` 改为 `5\.[123]`；
`renderer/settings/api/presets.ts` mainModels 补入 `glm-5.3`、`glm-5.2`。
补测试断言：`reasoning.test.ts` / `style-sampling.test.ts` / `profiles.test.ts` 各加 glm-5.3 用例。

**问题 1（批次 2）**：
- `harness-llm.ts` 新增 `resolveRequestMaxTokens`：OpenAI / Responses 协议不传 `maxTokens`
  （缺省即模型自身上限）；Anthropic 协议传必填安全大值 `ANTHROPIC_REQUIRED_MAX_TOKENS = 32_768`
  （Claude Sonnet 4.6+ 64k / MiniMax M3 / GLM-5.x / DeepSeek V4 均在限内）。
  `callLLM` 与 `summarizeHistory` 同步切换；`summarizeHistory` 的 `config` 参数随之移除。
- `config.reservedOutputTokens` 职责收窄为仅参与压缩预算计算（`types.ts` 注释已更新）。
- 截断可见化：主循环检测 `finishReason === "length"` 记 warn 日志；最终回复命中时在尾部追加
  "⚠️ 模型输出达到长度上限，以上回复可能不完整。"（`runtime_feedback` 不发 UI，故走 finalAnswer 后缀）。
- 新增测试：请求不含 maxTokens（openai 协议）+ length 截断提示。
- 注：非 Harness 的 ChatLoop（Anthropic 协议 DEFAULT_MAX_TOKENS=4096 兜底）本次未动，观察后再定。

**问题 2（批次 3）**：`ChatPage.tsx` 新增 `pendingModelProfileByMode`（与 `pendingWorkspaceByMode` 同构）：
欢迎页 `onSelectModelProfile` 暂存选择（同时 `activeModelProfileId` 显示暂存值，选择器立即反映）；
`ensureSession` 建会话后 `setModelProfile` 落地并清除暂存。

**验证**：`build:main`（tsc）、`build:renderer`（vite）通过；全量 vitest 316 文件 / 2526 测试通过。

---

## 问题 1（严重）：工具模式输出被 max_tokens=8192 硬截断，且无任何提示

**现象**：长任务遇上思维链严谨的模型（GLM-5.x / DeepSeek-V4 等），回复中途断掉，无错误、无提示。

**证据链**：

1. `src/main/orchestrator/harness/types.ts:138` — `DEFAULT_HARNESS_CONFIG.reservedOutputTokens: 8_192`。
2. `src/main/orchestrator/harness/harness-llm.ts:50` — `callLLM` 每轮请求都把它作为 `maxTokens` 发出（`summarizeHistory` 同样，L123）。
3. `src/main/orchestrator/harness-adapter.ts:305-310` — 调用方只覆盖
   `maxParallelToolCalls / totalTimeoutMs / contextWindowTokens` 三项，`reservedOutputTokens` 从未被覆盖，恒为 8192。
4. Harness 主循环**不检查 `finishReason === "length"`**，截断被当成正常结束——静默。
5. 现有逃生门 `disableMaxToken`（`vendors/runtime-settings.ts`）仅对自定义端点生效，
   preset 厂商被 `resolveVendorRuntimeSettings` 强制 `false`（L58-61），Harness 链路无法受益。
6. 非 Harness 的 Anthropic 协议另有 `DEFAULT_MAX_TOKENS = 4096` 兜底（`anthropic-adapter.ts:21`）。

**杀伤机制**：推理模型的思维链 token 计入输出预算——思考 7k token 后正文只剩 1k，
或思维链本身被拦腰截断。固定值无论 8k 还是 ×2（16k）都可能被吃穿，属于结构性问题。

**修复方向**（已对齐：A 为主 + 截断可见化，续写方案暂缓）：

- **A. 省略 max_tokens**：Harness 请求中 OpenAI 兼容厂商不携带 `max_tokens`（字段可选，
  缺省即模型自身上限）；Anthropic 协议因字段必填，改传模型级大值（32k/64k）。
  `reservedOutputTokens` 职责收窄为仅参与压缩预算计算（`computeTokenBudget`），不再限流。
  可复用 `disableMaxToken` 通道，为 Harness 链路单独放开。
- **B（补丁）. 截断可见化**：主循环检测 `finishReason === "length"`，发
  `runtime_feedback`（"输出被截断"），终结静默。
- **C（暂缓）. 截断自动续写**：拼回半截输出续写直至 stop。与工具循环纠缠深
  （思维链截断在 tool_call JSON 一半时参数残缺，需丢弃整轮重试），有真实需求再做。

---

## 问题 2（中危）：欢迎页切模型被静默丢弃，新会话仍用默认模型

**现象**：未发第一条消息（欢迎页，无会话）时通过 Composer 模型选择器切模型，
界面无反馈；发消息后新建的会话仍是旧模型。（开发版同样存在，非打包特有。）

**证据链**：

1. `src/renderer/react/features/chat/pages/ChatPage.tsx:1745-1762` — `createNewTask`
   回欢迎页时删除 `activeSessionIds[targetMode]`（欢迎页本无会话）。
2. `ChatPage.tsx:2356-2361` — `onSelectModelProfile` 首行 `if (!activeSessionId) return;`，
   欢迎页的选择被静默吞掉，无提示。
3. 发第一条消息时 `ensureSession`（L1668-1685）新建会话不带 `modelProfileId` → 默认模型。
4. 选择器显示兜底：`ModelSelector.tsx:19` 永远显示默认 profile，
   用户误以为"切过去了"，实际从未生效。

**修复方向**（仿照既有 `pendingWorkspaceByMode` 模式）：

- 欢迎页选模型时暂存 `pendingModelProfileByMode`；
- `ensureSession` 创建会话后立即 `setModelProfile` 应用；
- 有会话时走现有路径不变。改动集中在 `ChatPage.tsx`，约 10 行，与工作区暂存逻辑同构。

---

## 问题 3（轻危）：GLM-5.3 未纳入模型能力正则表，共 4 处失配

**现象**：思考链"能不能显示"不受影响（流式解析读 `reasoning_content` / `thinking`
字段，`openai-adapter.ts:168`，非正则）；受影响的是能力开关与档位。
另注：偏好为"跟随模型"（auto）时不发任何字段（`vendors/reasoning.ts:86-88`），
思考链出不出现完全取决于服务端默认值。

**失配明细**：

| # | 位置 | 正则 / 列表 | 5.3 现状 | 实际影响 |
| --- | --- | --- | --- | --- |
| 1 | `shared/reasoning.ts:173` | `/^glm-5\.2/i`（toggle-effort，高/最强） | 落到 `/^glm-5/i` 兜底（纯 toggle） | 思考链开关可用，但推理下拉缺"高/最强"档 |
| 2 | `vendors/style-sampling.ts:54` | `/^glm-(?:5\.[12]|5-turbo|4\.7)$/i` | 不命中 | 风格采样（温度多样性）静默失效 |
| 3 | `structured-output/profiles.ts:81` | `/^glm-(?:5\.[12]|4\.[67])(?:$|-)/i` | 不命中 | JSON 结构化输出回退默认模式 |
| 4 | `renderer/settings/api/presets.ts:58` | `mainModels: ["glm-5.1", "glm-5-turbo", "glm-4.7"]` | 不在列（连 5.2 也不在） | 新增端点推荐列表缺 5.2 / 5.3 |

**修复方向**：

1. `reasoning.ts`：`/^glm-5\.2/i` → `/^glm-5\.[23]/i`（获得 高/最强 档位）。
2. `style-sampling.ts`：`5\.[12]` → `5\.[123]`。
3. `profiles.ts`：`5\.[12]` → `5\.[123]`。
4. `presets.ts`：`mainModels` 补入 `glm-5.3`、`glm-5.2`。

**遗留风险（修完 1-4 后仍在）**：每次模型升级都需要手工同步 4 处正则。
长期可考虑收敛为单一模型能力表（型号 → 各能力位），或对未知版本号放宽系列级兜底；
本次先按最小改动对齐，不做结构性调整。

---

## 施工批次建议

- 批次 1（问题 3）：纯表项更新 + `reasoning.test.ts` / `style-sampling.test.ts` /
  `profiles.test.ts` 补 5.3 断言，风险最低，先行。
- 批次 2（问题 1）：Harness 省略 max_tokens + `length` 检测发 `runtime_feedback`；
  注意 `reservedOutputTokens` 在 `computeTokenBudget` 中的预算职责保留。
- 批次 3（问题 2）：ChatPage 暂存待应用模型，`ensureSession` 落地。
