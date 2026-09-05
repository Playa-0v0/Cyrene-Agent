# 工具模式覆盖失效 + MiniMax write_markdown 丢参数 + 覆盖写无防护 已知问题（2026-09-05 调研）

> 范围：`orchestrator/environment.ts`（环境上下文构建）、`orchestrator/build-options.ts`（options 组装）、
> `orchestrator/run-capabilities.ts` + `tools/registry/tool-registry.ts`（正确的过滤路径）、
> `orchestrator/agent-runtime.ts`（定时任务路径）、`channels/bootstrap.ts`（渠道路径）；
> 问题 2 涉及 `vendors/anthropic-adapter.ts` / `sdk-stream`（MiniMax anthropic 协议链路）；
> 问题 3 涉及 `tools/fs-tools.ts`（write_file）、`tools/document-tools.ts`（write_markdown）、
> `review/run-review-tracker.ts`（快照无恢复入口）。
> 问题 1 静态代码走读实锤；问题 2 已从 run 快照落盘数据实锤（问题出在模型侧，见证据链）；
> 问题 3 静态代码走读实锤（2026-09-05 晚补查）。

## 修复状态

| 问题 | 状态 | 修复位置 |
| --- | --- | --- |
| 1 环境上下文工具清单不按模式过滤——模式面板关掉的工具仍被"广告"给模型，调用即报 `E_TOOL_UNAVAILABLE` | 已拍板方案 B（删三行清单），见实施计划 3-1 | `environment.ts` L124-135 / L162-168 |
| 2 MiniMax-M3 调 write_markdown 连续 30 次 `filename` 参数缺失——**归属已确认：模型侧生成缺失**（跨会话复现 2 次，thinking 自证，见"核实补充"） | Cyrene 侧缓解已排期（报错增强 1-4 + 熔断 3-2），厂商反馈报告已起草（见 C；草稿：同目录 2026-09-05-minimax-m3-write-markdown-param-loss-report.md） | `document-tools.ts` / `tool-round.ts` |
| 3 覆盖写无防护：大文件被截断/缩水内容直接覆盖不设防 + 覆盖写无行级 diff、快照有数据无恢复入口（write_markdown 连快照都没接，2-0 先补）——**模型幻觉错一行可静默毁掉用户文件** | 已排期（第二批 2-0/2-1/2-2/2-3，快照保留策略已拍板），learn 开放与 str_replace 补强在第一批 | `fs-tools.ts` / `document-tools.ts` / `run-review-tracker.ts` |

---

## 问题 2（严重）：MiniMax-M3 连续 17 次调用 write_markdown 全部丢失 filename 参数

**现象**：learn 模式 + MiniMax-M3（anthropic 兼容协议）会话中，模型连续调用 `write_markdown` 十余次，
每次都被工具拒绝并返回 `[错误] filename 必须是 .md 结尾`。模型最终向用户认输：
"write_markdown 总是把 filename 参数丢掉，已经试了好几次都拿不到正确的返回"。
用户观察：模型多次重试无果，完全无法通过该工具写文件。

**实锤数据**（`%APPDATA%\live2d-cyrene\cyrene-runs\sessions\run-1788589328637-7ua0pd.json`，
2026-09-05 14:26，learn 模式，51 条消息，17 次 write_markdown 调用）：

1. **17 次调用全部没有 `filename` 键**：9 次只有 `content` 键、6 次 `input` 为空对象、
   2 次 `content` 极短（最小化排错尝试）。模型甚至在第 13-17 次调用中把 content 从
   14 字符递减到 2 字符做二分排错——模型自己在拼命定位问题，但每次生成的参数里都没有 filename。
2. **finalMessage（服务端返回的 tool_use block 原文）里同样没有 filename**：
   rawAssistant 里的 tool_use block `input` 键只有 `content` 或为空。这排除了
   "流式增量有、finalMessage 丢失"的中间层假设——服务端给出的最终消息就没有这个参数。
3. **同一会话早些时候 write_markdown 成功过**（run-1788585759107，13:22，同模型同协议，
   4 次调用全部带 filename 并成功生成文件）——说明不是 deterministic 的协议层 bug，
   而是模型生成质量随上下文状态劣化（该失败 run 有 51 条消息 + 长思维链）。
4. **Cyrene 侧链路逐环排查无过滤**：
   [anthropic-normalizer.ts](../../src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.ts)
   `input_json_delta` 纯拼接、[accumulator.ts](../../src/main/orchestrator/vendors/sdk-stream/accumulator.ts)
   纯累积、[anthropic-adapter.ts](../../src/main/orchestrator/vendors/anthropic-adapter.ts)
   `parseResponse` 对 `tool_use.input` 只做 `JSON.stringify` 原样转换、
   [tool-dispatcher.ts](../../src/main/orchestrator/harness/tool-dispatcher.ts) /
   [types.ts](../../src/main/orchestrator/harness/types.ts) `parseToolCallArgs` 只做 `JSON.parse`——
   中间没有任何环节会删除参数键。

**结论归属**：模型侧（MiniMax-M3 服务端）问题，**已确认**。模型在长上下文 + 多工具 schema 下生成
tool_use 参数时漏掉 required 字段，且收到"filename 必须是 .md 结尾"的明确错误提示后
仍无法自我纠正（跨两个会话连续 30 次），属于模型的结构化输出能力缺陷。Cyrene 中间层忠实传递了
模型的原始输出。

### 核实补充（2026-09-05 下午续查，归属定案）

在原"实锤数据"四条基础上，补齐了五条决定性证据，最终定案为**模型生成侧缺失**：

5. **跨会话复现（非孤例）**：同日 14:36 的 `run-1788589638221-q49aua.json`（新会话，57 条消息，
   同模型同模式）中 write_markdown 又被调用 13 次，**0 次带 filename**。失败模式跨会话完整复现，
   排除"单会话上下文偶然劣化"。时间窗观察：13:24 成功 → 14:26 / 14:36 连续两个 run 全失败，
   提示可能存在服务端时段性退化（或某种可复现的上下文触发模式）。
6. **schema 指纹一致，排除请求侧差异**：成功 run 与两个失败 run 的 `request.toolSchemaFingerprint`
   完全相同（`60390e92…a35`），write_markdown 的 schema（`required: ["filename", "content"]`）三轮
   一字未变。发给模型的工具定义没有差异，失败只能来自生成侧。
7. **流式与终态一致，排除流式累积丢失**：[anthropic-normalizer.ts](../../src/main/orchestrator/vendors/sdk-stream/anthropic-normalizer.ts)
   的 `reconcileAnthropicTerminal` 会在流式累积（live）与 finalMessage（terminal）的 tool_calls
   不一致时发出 `E_STREAM_TERMINAL_MISMATCH` 诊断；失败 run 的快照与 events.jsonl 中**均无任何
   mismatch 诊断**，且 17 次调用 `toolCalls.arguments`（解析后）与 `rawAssistant.tool_use.input`
   （服务端 block 原文）键集逐条完全一致（9×`[content]`、6×`{}`、2×短 content）。
   中间层每一环都忠实传递。
8. **模型 thinking 自证生成缺失（最直接证据）**：失败 run 的 thinking 块暴露了 MiniMax 内部的
   XML 工具调用格式（`<functions><invoke name="write_markdown"><parameter name="content">…</parameter>
   </invoke></functions>`，由 MiniMax 服务端转成 tool_use blocks），且模型自我诊断原话：
   *"There's no `<parameter name="filename">...</parameter>` at all! I'm not generating it."*
   ——模型清楚地知道需要两个参数、也在 thinking 里计划了两个参数，但**生成的 XML 里从未包含第二个
   `<parameter>`**。filename 恰好是排在长 content（最长 3832 字符）之后的第二个参数，6 次 `{}`
   空调用说明退化时连第一个参数都发不出。
9. **与问题 1 的关联实锤（干扰因素，非决定性触发器）**：失败 run 的 thinking 原话确认模型被
   问题 1 泄漏的全量清单带偏：*"the runtime context listed write_file, str_replace, etc. But
   they're not in my actual function schema. This is a mismatch between the runtime context and
   what was exposed to me"*。两个失败 run 均先尝试调 schema 外工具（apply_patch / str_replace /
   write_file / run_shell，共 8 次），全部被拒后才退化到 write_markdown。**但反证存在**：成功 run
   也有 3 次 schema 外调用失败（str_replace×2、apply_patch×1），其 4 次 write_markdown 却全部带
   filename——所以问题 1 是加剧模型混乱的因素，不是 filename 缺失的确定性触发条件。

**核实中确认的旁证（修正原文档两处表述）**：

- schema 外工具调用的实际拒绝信息是 `{"outcome":"failure","category":"not_found","message":"工具
  \"apply_patch\" 未注册"}`（工具分发层 registry 查找），不是 `E_TOOL_UNAVAILABLE`（runnableToolIds
  校验层）——两层防线都在，越权执行不存在；`toolCalls` 里的 `status: committed` 只是记录生命周期
  状态，不代表执行成功。
- 成功 run（run-1788585759107）中存在大量**重复的 toolCallId**（如 `call_01a07004c` 出现 3 次），
  是 MiniMax 侧 tool_use id 复用的另一个怪癖，与本问题无直接关系，留档备查。
- MiniMax 会把模型内部 XML 格式的工具调用（包括 schema 外的工具名）原样解析成 tool_use block
  下发——即 tools 数组并未约束模型可"调用"的工具名，Cyrene 执行侧的 registry/权限双防线是唯一
  闸门，问题 1 的修复（清单口径统一）价值因此更高。

**加剧因素（Cyrene 侧可改进）**：

- **learn 模式文件编辑能力缺口（2026-09-05 补充实锤）**：支持追加/局部编辑的工具
  （`write_file` 带 append、`str_replace`、`apply_patch`）modes 均为 `["code","work"]`，
  learn 模式下全部不可用，唯一可写文件的是整文件覆盖式的 `write_markdown`
  （[document-tools.ts L558](../../src/main/orchestrator/tools/document-tools.ts) `fs.writeFileSync`）。
  失败 run 中模型想给已有笔记"追加一段"，调 str_replace/apply_patch/write_file 全被"未注册"拒绝后，
  只能每次背着 3800+ 字符全文重写——超长 content 恰是 filename（第二个参数）被丢弃的载体。
  既放大 token 消耗，又加大丢参数概率，还与问题 1 的泄漏清单形成叠加误导。
- 错误反馈循环没有增量信息：每次失败都返回同一句"filename 必须是 .md 结尾"，
  模型拿不到"你这次只传了 content 键"的具体反馈，重试变成盲目重复（17 次里 6 次
  input 完全为空——模型已经慌了）。
- 无熔断：同一工具连续失败 17 次没有被 runtime 拦截，烧了大量 token 和时间。

**修复方向（Cyrene 侧缓解，A/B 已排期见实施计划 1-4/3-2，C 报告已起草）**：

- **A. 错误信息增强（推荐，低成本）**：参数校验失败时回传收到的实际键名，
  如 `[错误] filename 必须是 .md 结尾；本次收到的参数键：[content]（缺少 filename）`，
  给模型明确的纠错信号。document-tools.ts 四个工具（write_excel/word/pdf/markdown）
  的 `validateFilename` 统一改。
- **B. 同工具连续失败熔断**：runtime 层记录同 run 内同工具连续参数校验失败次数，
  超过阈值（如 5 次）后拒绝执行并要求模型改用其他方案或求助用户，避免无限重试烧 token。
- **C. 向 MiniMax 反馈（报告已起草）**：反馈草稿见同目录
  [2026-09-05-minimax-m3-write-markdown-param-loss-report.md](./2026-09-05-minimax-m3-write-markdown-param-loss-report.md)
  （复现条件 + 证据链 + 对照组 + 次要发现），run 快照（tool_use id 序列：call_f3600351... 共 17 个等）
  可按需附上；待用户过目后经官方渠道提交。

**复现素材**：两个失败 run 快照（`run-1788589328637-7ua0pd.json` 17 次 + `run-1788589638221-q49aua.json`
13 次）完整保留了 30 次调用的 arguments 原文、模型 thinking（含 XML 格式自我排错过程与
"I'm not generating it" 自证）、以及 finalMessage 的 rawAssistant blocks；加上成功 run
`run-1788585759107-mre2r3.json`（同 schema 指纹、4 次全成功）作为对照组，可直接用于复现和
厂商反馈。

---

---

## 问题（中高严重）：模型"看得见调不了"的工具清单

**现象**：用户在模式工具面板把某工具（如 `run_shell`）在当前模式下关掉后，模型仍会在回复中尝试调用该工具，
然后收到 `E_TOOL_UNAVAILABLE 工具不可用` 的失败结果。模型可能重试、瞎编参数、或向用户抱怨工具坏了——
表现为"工具面板开关无效，只是从能调用变成了不能调用"。

**复现路径**：

1. 设置 → 工具模式面板，在 work 模式关掉一个工具；
2. work 模式对话，诱导模型使用该工具（或看日志中模型的 tool_call 尝试）；
3. 事件流中出现 `工具不可用: <toolId>`（`E_TOOL_UNAVAILABLE`），但模型当轮系统提示词里
   "当前档位下可直接调用的工具"清单仍包含该工具 id。

**根因**：系统提示词里有两份工具信息，口径不一致——

- **正确的一份**：tools Schema 数组 + 工具目录 prompt，走
  [run-capabilities.ts](../../src/main/orchestrator/run-capabilities.ts) →
  `getEnabledToolsForMode(mode, toolModeOverrides)`，模式覆盖生效，关掉的工具不出现；
- **错误的一份**：环境上下文（[environment.ts](../../src/main/orchestrator/environment.ts)）里的
  三行权限档位清单，用 `toolRegistry.getEnabledTools()` 构建——**只看总开关 + deprecated，
  完全无视 `ToolDefinition.modes` 和 `toolModeOverrides`**。

模型读到"当前档位下可直接调用的工具：run_shell(dangerous), …"，自然去调；
实际 tools 数组里没有它，执行侧 [cyrene-agent.ts](../../src/main/orchestrator/cyrene-agent.ts)
的 `runnableToolIds` 校验直接拒绝。

**证据链**：

1. [environment.ts L124-135](../../src/main/orchestrator/environment.ts)：`getEnabledTools()` 只按
   `enabled && !deprecated` 过滤，按权限档位分三桶（allow/ask/denied）；
2. [environment.ts L162-168](../../src/main/orchestrator/environment.ts)：三行清单原文——
   "当前档位下可直接调用的工具 / 需先弹审批的工具 / 被拒绝的工具（提到也调不出）"，
   语义上向模型承诺了可用性，但口径只有风险档位，没有模式维度；
3. [tool-registry.ts L137-144](../../src/main/orchestrator/tools/registry/tool-registry.ts)：
   `getEnabledToolsForMode` 才是带 `toolModeOverrides` 的正确过滤（override > modes > 全可见），
   environment.ts 没有走它；
4. [build-options.ts L520-537](../../src/main/orchestrator/build-options.ts)：environmentContext 在
   L523 构建，**早于** L629 的 `resolvedMode` 和 L744-763 的 capabilities/runTools 计算——
   时序上就拿不到"本轮实际可调用列表"；
5. [build-options.ts L772-774](../../src/main/orchestrator/build-options.ts)：工具目录 prompt
   `buildToolSystemPrompt(resolvedMode, runTools)` 用的已过滤列表——两份口径在同一份
   toolSystemContent/runtimeContext 里并存冲突；
6. [cyrene-agent.ts L341-347](../../src/main/orchestrator/cyrene-agent.ts)：执行侧
   `runnableToolIds.has(tc.name)` 校验 → `E_TOOL_UNAVAILABLE`，即用户看到的"调不了"。

**影响面（三条路径同病）**：

| 路径 | 系统提示词里的清单 | 实际可调用 | 状态 |
| --- | --- | --- | --- |
| 桌面主链路 | `getEnabledTools()` 全量 | `getEnabledToolsForMode` 过滤 | 不一致（主 bug） |
| 定时任务（[agent-runtime.ts L333-343](../../src/main/orchestrator/agent-runtime.ts) 拼 `buildEnvironmentContext`） | 同一份全量清单 | [scheduler-runner.ts](../../src/main/scheduler/scheduler-runner.ts) `filterToolsForTask` 任务白名单 | 不一致 |
| 渠道（[bootstrap.ts](../../src/main/channels/bootstrap.ts) 走 buildOptions） | 同一份全量清单 | capabilities（已过滤）或 `policy.exposeTools` | 清单同样泄漏 |

**加重因素**：chat 模式（未开工具增强）也无条件收到这份全量清单——纯闲聊会话里模型被明确告知
"可直接调用 run_shell(dangerous)"，虽然 ChatLoop 没有工具可调不会真的执行，但模型可能据此
向用户宣称自己有能力执行 shell / 读写文件，属于能力幻觉的直接来源。

**为什么不是安全漏洞**：执行侧双保险（`runnableToolIds` + 权限档位 `checkPermission`）都在，
关掉的工具不会被真正执行。危害是"误导模型"——失败调用浪费轮次、触发重试循环、
污染对话体验，而非越权。

**修复方向（已拍板 B，2026-09-05；实施细节见文末"修复实施计划"3-1）**：

- 方案 A（保守，未采用）：`buildEnvironmentContext` 增加可选参数，传入"本轮实际可调用的工具列表"，
  清单只列这些。桌面路径需把 environmentContext 构建挪到 capabilities 计算之后
  （build-options.ts 内 L520 → L763 之后）；定时任务/渠道路径同理传各自过滤后的列表。
  缺点：三条路径都要接线，且"清单"与工具目录 prompt 仍是双重定义。
- **方案 B（已拍板）**：环境清单三行工具列表整个删除（[environment.ts L124-135](../../src/main/orchestrator/environment.ts)
  三桶构建 + L162-168 三行清单），环境段只保留权限档位的**规则说明**
  （如"当前档位：标准，safe 工具直接执行、dangerous 需审批"），不列具体工具 id。
  工具可见性由 tools Schema + 工具目录 prompt（均已正确过滤）两道口说话，
  信息不重复、口径天然一致、一处改动覆盖全部三条路径。

**缓存影响评估**：environmentContext 进入 `soulRuntimeContext`（每轮变化的尾部 runtime 层，
不在 stablePrefix 缓存前缀里，见 [build-options.ts L799-820](../../src/main/orchestrator/build-options.ts)
的分层注释），两个方案改动均不伤厂商提示词缓存。定时任务/渠道路径无缓存分层，无影响。

---

## 问题 3（高危）：覆盖写无防护 + 审查盲区 + 快照无恢复入口

**现象（两个危险点，均静态走读实锤）**：

**危险点 A：大文件整文件覆写不设防——截断/缩水内容可直接毁掉原文件**

模型对已有大文件做整文件覆写（`write_file` 覆盖模式 / `write_markdown` 同名重写）时，
两种截断结局完全不同：

1. **硬截断（max_tokens 截断 JSON）**：tool call 的 arguments JSON 不完整 →
   `parseToolCallArgs` 解析失败 → 调用整体被拒，**文件不坏**（现有防线有效）；
2. **软截断（模型"自以为写完了"，生成完整 JSON 但内容缩水/幻觉截尾）**：
   JSON 合法 → 写入成功 → **原文件被截断版静默覆盖，原内容丢失**。
   现有代码对此**零防护**：`write_file` 不校验"目标文件 2000 行、你写的内容 800 行，
   确认要覆盖吗"；`write_markdown` 同样直接 `fs.writeFileSync`。触发概率不低——
   问题 2 的失败 run 已经证明模型会在长 content 生成时丢尾部/丢参数。

**危险点 B：覆写错了看不见、也救不回——审查盲区 + 恢复链路断裂**

模型幻觉写错一行（甚至错一片）时，用户侧的三道保障全部缺位：

1. **Diff Review 卡片对覆盖写没有行级 diff**：
   [fs-tools.ts L334-340](../../src/main/orchestrator/tools/fs-tools.ts) 注释自认
   "覆盖写没有行级 diff（全文替换），只给统计"——`changes` 只有 `kind: modified` +
   insertions 统计，用户在审查卡片上**看不到改了哪些行**（对比：append/新建有全文 diff，
   apply_patch / str_replace / ast_grep_replace 有行级 diff）。
2. **快照有数据、无恢复入口（且接入面有缺口，2026-09-05 晚补查实锤）**：
   [run-review-tracker.ts](../../src/main/orchestrator/review/run-review-tracker.ts) 是 write-ahead 设计，
   mutation 前**原始全文已落盘**（`cyrene-runs/reviews/<runId>/before/<hash>`，崩溃不丢，
   惰性快照只存第一次修改前）——但这层保障只有 write_file（fs-tools.ts L289-292）和
   str_replace（life-tools.ts L489-490）接了 `captureBefore`；**document-tools.ts 四个写入工具
   （write_markdown/excel/word/pdf）零接入**，write_markdown 覆盖已有文件时是裸写，连快照都不存在。
   已接入的部分，代码里也只有 `captureBefore` / `readBeforeContent` / `finalizeReview` / `loadReview`，
   **没有任何 restore/undo API 或 UI**——快照救不了不知道它存在的用户；没接入的工具连被救的原料都没有。
3. **非 git 场景裸奔**：code 模式有 git 工具兜底；learn / work 模式写桌面或非 git 目录时，
   唯一的恢复原料就是上述 review 快照，但缺恢复入口等于没有。

**连带能力缺口：编辑工具缺容错工程（2026-09-05 晚修正，对齐业界）**

行业核实（Claude Code / Anthropic 官方 text editor tool / Aider / Cline）：主流成熟 agent 的
编辑语义**全部是替换式**——删一行=把该行替换成空（old_string=该行原文，new_string=""），
补一行=锚点行替换成"锚点行+新内容"；**没有一家提供行号删除工具**，因为行号锚点被实践淘汰
（模型数不准行），内容锚点最稳。它们好用靠的是替换式之下的容错工程，Cyrene 只做了壳：

| 业界标配 | Cyrene `str_replace` 现状 |
| --- | --- |
| 缩进/空白归一化模糊匹配（Cline） | 要求精确匹配，差一个空格即失败 |
| 失败返回最相近候选片段助模型自纠（aider） | 只报"不唯一/不匹配"，模型盲猜重试 |
| 一次调用批量多处替换（multi-edit；内容锚点天然无行号漂移） | 一次一处 |
| insert 独立命令（行锚定+邻行内容校验，Anthropic text editor tool） | 无 |
| 模型在编辑格式上训练过（Claude/GPT 系） | 接 MiniMax 等第三方，纯 prompt 驱动——容错需求反而更高 |

learn 模式的编辑能力缺口（见问题 2"加剧因素"首条）也在此一并解决。

**证据链**：

1. [fs-tools.ts L294-299](../../src/main/orchestrator/tools/fs-tools.ts)：覆盖写直接
   `fs.writeFileSync`，写前无行数/尺寸 sanity check（写前只有 `captureBefore` 快照）；
2. [fs-tools.ts L324-340](../../src/main/orchestrator/tools/fs-tools.ts)：覆盖写的
   `changes` 无 `diff` 字段（对比 append/新建走 `buildFullFileDiff`）；
3. [document-tools.ts L558](../../src/main/orchestrator/tools/document-tools.ts)：
   `write_markdown` 整文件覆盖写，同样无骤降检查、无行级 diff；
4. [run-review-tracker.ts L4-18](../../src/main/orchestrator/review/run-review-tracker.ts)：
   baseline 快照的 write-ahead 落盘机制完整，但全仓库无 restore 调用方；
5. 工具注册面（`modes` 字段）：所有编辑类工具（write_file/str_replace/apply_patch/ast_grep_replace）
   均为 `["code","work"]`，learn 模式无任何局部编辑能力。
6. **write_markdown 未接入 review 快照（2026-09-05 晚补查实锤）**：
   [document-tools.ts](../../src/main/orchestrator/tools/document-tools.ts) 全文件无
   `captureBefore` 调用（对照 write_file [fs-tools.ts L289-292](../../src/main/orchestrator/tools/fs-tools.ts)
   与 str_replace [life-tools.ts L489-490](../../src/main/orchestrator/tools/life-tools.ts) 均已接入）。
   write_markdown 是 learn 模式唯一可写工具（问题 2 加剧因素），覆盖写却连修改前快照都没有——
   修复清单第 2、3 项对它天然失效，需先补接入（实施计划 2-0）。

**修复清单（按优先级，1-2 对应两个危险点，建议尽快落）**：

1. **覆写骤降检查（高危 A，拒绝机制已拍板）**：`write_file` 覆盖模式（及 `write_markdown`）在目标文件
   已存在且新内容行数 < 原文件 50% 时拒绝执行，报错回传两侧行数。拒绝后**不新增确认参数**——
   可选参数在丢参模型上是新的丢参载体（问题 2 实锤：连 required 都连续丢 30 次），报错文案引导：
   局部修改改用 str_replace/apply_patch；确需整文件替换则分两次调用（先覆盖写主体、再 append 补尾，
   1-2 落地后 write_markdown 也有 append）。防软截断/缩水静默毁文件。
2. **覆盖写补行级 diff（高危 B，write_markdown 依赖 2-0 前置）**：before 内容就在 review tracker 里，
   覆盖写时生成 before→after 全文 diff 塞进 `changes.diff`（复用 `buildFullFileDiff` /
   `parseUnifiedPatch`，diff 行上限 `finalizeFileChanges` 已有）——消掉审查盲区。
3. **快照恢复入口（高危 B，保留策略已拍板）**：基于 `before/<hash>` 做"一键恢复该文件"
   （IPC API + Review 卡片按钮）。保留/清理策略：超过 30 天的 `reviews/<runId>/` 目录清理；
   兜底总量超 200 个 run 目录或 500MB 时按最旧优先清理——笔记类损坏常在数日后才发现，7 天过短；
   write-ahead 是全文快照，30 天兼顾恢复窗口与磁盘占用。
4. **`str_replace` 容错增强（对齐业界，优先于行号删除）**：
   a. 空白/缩进归一化匹配（trim + 行内空白折叠后比对，命中后仍按原文替换）；
   b. 失败时回传最相近候选片段（前 N 字符 diff），给模型明确纠错信号；
   c. 支持 `edits` 数组一次调用多处修改（内容锚点无行号漂移，顺带省轮次）；
   d. 可选补 `insert` 命令（Anthropic text editor tool 同款：行号 + 邻行内容校验）。
   注：原设想的 `delete_lines`（行号删除）降级为不推荐——业界已验证行号锚点不可靠，
   删除走"old_string=目标行、new_string 空"即可。
5. **learn 模式开放局部编辑**：`str_replace` 的 modes 扩到 learn（有"old_string 唯一匹配"
   安全约束，比开放 write_file 风险面小）；与问题 2 修复方向联动。

---

## 修复实施计划（2026-09-05 拍板）

> 两轨：learn 模式做减法开放 + 补强现有工具（不加新工具）。所有落点已对照代码核实。

### 第一批（见效最快，单文件内改动）

| # | 改动 | 落点 | 已核实细节 |
| --- | --- | --- | --- |
| 1-1 | `str_replace` 开放 learn 模式 | `life-tools.ts` `modes: ["code","work"]` → 加 `"learn"` | 有"old_string 唯一匹配"安全约束，失败不落盘；modes 语义见 tool-registry L70-73 |
| 1-2 | `write_markdown` 加 `append` 可选参数 | `document-tools.ts` write_markdown | 默认 false 覆盖；append 时 `fs.appendFileSync`；文件不存在等价新建；description 更新"何时用追加"；只加一个 boolean，不给弱模型加丢参风险 |
| 1-3 | `str_replace` 容错增强 | `life-tools.ts` | a. 空白/缩进归一化匹配（trim+行内空白折叠比对，命中后按原文替换）；b. 失败回传最相近候选片段（前缀 diff）；c. `edits` 数组批量（内容锚点无行号漂移） |
| 1-4 | 参数报错增强（问题 2 缓解 A） | `document-tools.ts` `validateFilename` 调用处 | 失败时回传实际收到的键名：`filename 必须是 .md 结尾；本次收到的参数键：[content]（缺少 filename）`——write_excel/word/pdf/markdown 四处统一 |

> 实施注：1-1 与 1-3 同改 `str_replace`（schema 与 handler），合并为一次改动一次提交，避免中间态。

### 第二批（快照接入 + 覆写防护三件套，问题 3 高危项）

| # | 改动 | 落点 | 已核实细节 |
| --- | --- | --- | --- |
| 2-0 | write_markdown 接入 review 快照（2-1/2-2 前置） | `document-tools.ts` | 2026-09-05 晚补查实锤：document-tools.ts 全文件无 `captureBefore`（write_file/str_replace 均已接入），write_markdown 覆盖写是裸写。复用 `getRunReviewTracker().captureBefore`（fs-tools.ts L289-292 同款）；write_excel/word/pdf 二进制只存 metadata（可选，随 2-3 一并落） |
| 2-1 | 覆写骤降检查 | `fs-tools.ts` `executeWriteFile` / `document-tools.ts` | 目标文件已存在（`existedBefore` 已有）且新内容行数 < 原文件 50% 时拒绝，报错回传两侧行数。已拍板：不新增确认参数（可选参数是丢参载体，见问题 2 教训），文案引导分两次写（覆盖主体 + append 补尾）或改用 str_replace/apply_patch；防软截断静默毁文件 |
| 2-2 | 覆盖写补行级 diff | `fs-tools.ts` L324-340 | before 内容在 review tracker（`readBeforeContent`），生成 before→after diff 塞 `changes.diff`，复用 `buildFullFileDiff`/`parseUnifiedPatch`，上限 `finalizeFileChanges` 已有；write_markdown 依赖 2-0 先接入 |
| 2-3 | 快照恢复入口 | `review/run-review-tracker.ts` + IPC | 缺 restore API + Review 卡片按钮。保留策略已拍板：超过 30 天的 `reviews/<runId>/` 清理；兜底总量超 200 个 run 目录或 500MB 按最旧优先（笔记类损坏常在数日后才发现，7 天过短；write-ahead 是全文快照，30 天兼顾恢复窗口与磁盘占用） |

### 第三批（口径与熔断）

| # | 改动 | 落点 | 已核实细节 |
| --- | --- | --- | --- |
| 3-1 | 问题 1 方案 B：删除环境清单三行 | `environment.ts` L124-135（三桶构建）+ L162-168（三行清单） | 保留 L161 档位行，可补一句规则说明（"safe 直接执行、fs-write/dangerous 需审批"）；一处改动覆盖桌面/定时任务/渠道三条路径；不在 stablePrefix 缓存层，不伤提示词缓存。需补测试：断言 buildEnvironmentContext 产出不含工具 id 清单 |
| 3-2 | 同工具连续失败熔断（问题 2 缓解 B） | `harness/tool-round.ts` `commitToolResult`（每次结果提交必经点） | `run.state` 挂 `Record<toolId, 连续失败次数>`：failure 时 ++，成功清零；超阈值（5）后该工具后续调用合成 not_executed + 提示模型换方案或求助用户。注意：write_markdown 报错走返回字符串路径（classify 为 semantic_failure），熔断条件按"同工具连续 failure"计，不细分 category |

### 不做（已论证否决）

- `delete_lines` 行号删除工具——业界（Claude Code / Anthropic text editor tool / Aider / Cline）全部是替换语义，行号锚点被实践淘汰；
- `write_file` 开放 learn——任意绝对路径，与 learn 窄路径设计冲突；
- 引入 OpenAI Agents SDK——三个 issue 全在 SDK 不负责的应用层（prompt 组装 / 文件安全 / 多厂商兼容），且 Cyrene 的多厂商 sdk-stream 对账、rawAssistant 回放是针对非 OpenAI 厂商的自有资产；
- 快照恢复之外的 undo/rollback 体系——先做最小闭环（2-3），按需演进。

---

## 备注

- `ToolDefinition.modes` 的语义（[tool-registry.ts L70-73](../../src/main/orchestrator/tools/registry/tool-registry.ts)）：
  "默认推荐，可被 ToolModeOverrides 覆盖"——environment.ts 的清单构建完全绕过了这层约定，
  属于三模适配改造时的遗漏点。
- 修复时建议补一条测试：对同一 registry + overrides 输入，断言 `buildEnvironmentContext`
  产出的文本不包含被模式关闭的工具 id（方案 B 则断言不再出现任何工具 id 清单）。

---

## 施工方案（2026-09-05 拍板，开工前走读勘定）

> 施工前对全部落点做了二次走读，修正了五处与代码现状的偏差；施工顺序按依赖与风险重排，
> 不再按原"第一批/第二批/第三批"分组（原分组是主题归类，非依赖顺序）。

### 走读勘定（与上文拍板的差异，以本节为准）

1. **1-3 的 b 项已实现**：`life-tools.ts` L316 `findNearestMatch` / L353 `findAllMatchPositions`
   已存在——old_string 未找到时回传最近似片段（行号 + 相似度 + 上下文），多处匹配时回传
   前 5 个位置；CRLF/LF 的 EOL 归一化（L429-439）也已实现。上文"业界对标表"中
   "只报不唯一/不匹配"一行已过时。**1-3 剩余实际工作：a 空白/缩进归一化 + c edits 批量**。
2. **2-1 的"分两次写"逃生通道有洞（修正原拍板）**：原定"先覆盖写主体、再 append 补尾"
   不成立——第一次覆盖写本身就触发骤降拒绝（前半段行数 < 原文件 50%）。合法整文件重写的
   可行出口只剩两个：str_replace（old_string = 原文件全文，唯一匹配保证成功，代价是 token）
   或求助用户。2-1 报错文案按此引导。
3. **2-2 不走 readBeforeContent**：tracker 里的基线是"本 run 第一次修改前"，若本轮早前
   已改过该文件，基线是旧状态而非本次写前状态，diff 会失真。改为**写前直接读一次当前文件**：
   同一次读同时服务骤降行数统计（2-1）与 diff 生成（2-2），语义正确且省一次哈希耦合；
   diff 复用 `buildReplacedDiff`（life-tools 同款）。
4. **write_markdown 要吃进 2-2 必须改返回体**：它现在返回纯字符串
   `[write_markdown] 已生成：…`，而 Diff Review 卡片证据链（`extractFileChangesFromOutput`）
   解析的是 JSON `changes`——write_markdown 的写入目前在审查卡片上**完全不可见**。
   需改成 write_file 同款 JSON 返回（C5 一并落）。
5. **3-2 有自我解除陷阱**：熔断后合成的 `not_executed` 结果会流回 `commitToolResult`，
   若计数规则是"非 failure 即清零"，熔断会被自己合成的结果解除。规则必须是：
   **failure 递增、success 清零、not_executed / unknown 不动**。拦截点在
   `executeToolCallWithRetry` 顶部（dispatch 之前），计数点在 `commitToolResult`
   （结果必经点，与原拍板一致）。

另两处小勘定：environment.test.ts 现有断言不涉及三行清单（3-1 删除不炸现有测试）；
fs-tools 无删除类工具（2-1 报错指引不能提 delete）。

### 施工顺序（C1 → C7，每步实现 → npm test 全量 → 单独 commit）

| # | 内容 | 落点 | 验证 |
| --- | --- | --- | --- |
| C1 | 3-1 删环境清单三行（保留档位行 + 规则说明）。**提到首个**：diff 最小、零依赖、立刻止血问题 1，桌面/定时任务/渠道三路径一次全修 | `environment.ts` L124-135 + L162-168 | environment.test.ts 补断言：产出不含任何工具 id 清单 |
| C2 | 1-1 + 1-3 str_replace：开放 learn + 空白/缩进归一化 + edits 批量（先加固再开放，一次提交） | `life-tools.ts` L384-517 | life-tools.test.ts 扩充 |
| C3 | 1-4 + 2-0 document-tools：报错回传实际键名 + captureBefore 接入 | `document-tools.ts` | 新建 document-tools.test.ts |
| C4 | 1-2 write_markdown 加 append 参数（schema 变化单独提交，便于回滚） | `document-tools.ts` | 同上 |
| C5 | 2-1 + 2-2 覆写防护：骤降检查 + 行级 diff，write_file 与 write_markdown 联动（write_markdown 返回体改 JSON） | `fs-tools.ts` L260-345 + `document-tools.ts` | fs-tools.test.ts 扩充 |
| C6 | 2-3 恢复入口：tracker restore API + IPC + Review 卡片按钮 + 30 天 / 200 目录 / 500MB 清理 | `run-review-tracker.ts` + IPC + 渲染端 | tracker 新增测试 + UI 手动验证 |
| C7 | 3-2 熔断：连续失败计数 + 超阈值合成 not_executed | `tool-round.ts` L222-270 | 抽纯函数 breaker 单测 |

- C7 碰 harness 核心、C6 是唯一碰渲染端的提交（动手前先定位 Review 卡片组件），均放最后；
- 每 commit 只做一件事，失败可单独 revert。

### 骤降检查底线（已定，数值可调）

原文件 **≥ 50 行**且新内容 **< 50%** 才拒绝。小文件合法缩水常见（10 行笔记整理成 4 行），
diff 卡全量可见、恢复容易，不该拦；大文件骤降才是软截断高危特征。
