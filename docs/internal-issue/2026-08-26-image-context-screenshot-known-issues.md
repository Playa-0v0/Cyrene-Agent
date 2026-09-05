# Anthropic 发图 / 图片上下文虚高 / 压缩后环形图不刷新 / 截图半成品 已知问题（2026-08-26 调研）

> 范围：厂商适配层（`vendors/anthropic-adapter.ts` / `vendors/capabilities.ts`）、上下文计量
> （`orchestrator/context-usage.ts` / `context-manager.ts`）、手动压缩 IPC（`chats/chats-ipc.ts`）、
> 截图链路（`screenshot/` + `ChatPage.tsx` / `ChatComposer.tsx`）。
> 全部为静态代码走读确认；问题 1 另有用户提供的 400 报错堆栈佐证（MiniMax `/anthropic` 端点）。

## 修订记录

| 版本 | 说明 |
| --- | --- |
| v1（2026-08-26） | 初版调研 + 修法 |
| v2（2026-08-26） | 按外部 review 修订：① 问题 1 改为 capability 驱动（MiniMax `/anthropic` 按官方公开文档不支持 `type:image`，不能按协议假定能力）；② 问题 2 删除 `/750 + 1600` 硬编码，改为统一 estimator + 保守回退（协议 ≠ tokenizer）；③ 问题 3 撤回「无需前端改动」（已核实前端写入依赖 run 上下文的 `assistantId`），补 session 级状态长期方案；④ 问题 4 补 MIME 白名单 / 大小限制 / preventDefault 细节 |
| v3（2026-08-29） | **修复核实关闭**：四个问题全部核实已修，状态表改为「已修」，各问题节头补修复证据。核实方式为静态代码走读（与本文调研同方法），GameBot 设计稿（`gamebot-Honkai-Star-Rail.md` §8.1）依赖此结论解除 P0 阻塞 |

**贯穿性设计原则**（本次 review 的核心结论）：

> Provider（供应商）、Model（模型）、Protocol（协议）是三个独立维度。
> **能力**（能不能看图）来自 Provider + Model；**序列化方式**（image 怎么编码上 wire）才来自 Protocol。
> 不得用「当前走什么协议」推断「模型具有什么能力」。

---

## 问题总览

| # | 问题 | 严重度 | 状态（2026-08-29 核实） |
| --- | --- | --- | --- |
| 1 | Anthropic 协议发图 400：`image_url` 块未转换透传 + MiniMax `/anthropic` 端点本身不支持 image block | 高（功能不可用） | **已修** |
| 2 | 图片按 base64 文本计量 token，虚高约百倍，连带误触发自动压缩 | 高（连带伤害） | **已修** |
| 3 | 手动压缩后上下文环形图不刷新，需再对话一次才更新 | 中（体验 + 架构隐患） | **已修** |
| 4 | 截图功能半成品：粘贴未实现、失败静默、multimodal 默认关 | 中 | **已修** |

---

## 问题 1（严重）：Anthropic 协议发不了图，OpenAI / Responses 正常

> **✅ 已修**（2026-08-29 核实）：`orchestrator/vendors/anthropic-adapter.ts:60-105` 已实现
> `image_url` → Anthropic `source.type=base64` / `source.type=url` 转换，带四种 MIME 白名单
> （png/jpeg/webp/gif）与降级保护（不在白名单降级为文本而非发坏请求），并附 `[image-send]`
> wire 链路诊断日志。

**现象**：工具模式（Harness）带图发送直接报错：

```
AgentRuntimeError: 模型服务请求失败。
  [cause]: BadRequestError: 400
  {"error":{"type":"invalid_request_error",
  "message":"invalid params, messages.1.content.1: unsupported content type 'image_url' (2013)"}}
```

模型为多模态（MiniMax M 系列，走 `/anthropic` 端点）。

**根因**（两层，均需修）：

第一层——本地转换缺失：

1. `src/main/orchestrator/build-options.ts:281-313`（`withDirectImageAttachments`）— 把
   `input.imageAttachments` 读为 base64，构造 **OpenAI 风格** 块挂到最新 user 消息上：

   ```ts
   blocks.push({
     type: "image_url",
     image_url: { url: `data:${validated.mime};base64,${...}` },
   });
   ```

2. `src/main/orchestrator/vendors/anthropic-adapter.ts:80-81`（`toWireMessages`）— user 分支
   `wire.push({ role: "user", content: m.content ?? "" })`，content block 数组原样进请求体。
3. OpenAI 协议原生认 `image_url`；Responses 协议在 `responses-adapter.ts:85-90` 另有
   `image_url → input_image` 转换——唯独 Anthropic 协议没有对应转换。
   原生 Anthropic 协议的图片格式是 `{ type: "image", source: {...} }`，且当前同时支持
   `base64` / `url` / `file` 三种 source（官方文档，2026-08 核实）。

第二层——**协议兼容 ≠ 能力兼容**（外部 review 指出的关键事实）：

> MiniMax 当前公开的 Anthropic-compatible API 文档明确标注 `type="image"` 不支持
> （messages 仅部分支持 text / tool calls）。MiniMax M3 模型本身原生多模态
> （image_url / video_url），但其视觉输入走 **OpenAI 兼容入口**（`/v1`）。

这一点在本地能力表里其实已有印证——`src/main/orchestrator/vendors/capabilities.ts:8-28`
MiniMax 条目：

```ts
supportsVision: true,
// 视觉仍走 OpenAI 兼容入口。
visionBaseUrl: "https://api.minimaxi.com/v1",
```

即：**MiniMax + Anthropic 协议 + 带图** 这个组合本来就不该直发图片。当前
`build-options.ts:749` 的直发判定只看用户开关 `settings.multimodal`，没看
provider × transport 的能力矩阵，这是 400 的真正触发条件。

**修法**（capability 驱动，两步）：

**第 1 步：能力表加「哪些 transport 支持直发图片」维度**。

`capabilities.ts` 的 `ProviderCapability` 增加：

```ts
/** 支持直发图片的 transport 列表（模型级多模态能力在协议上的可用面）。
 *  MiniMax：视觉只走 OpenAI 兼容入口（官方 /anthropic 文档明确 image 不支持）。
 *  Claude：自家 anthropic 协议原生支持。 */
visionTransports?: Transport[];
```

各厂商初值（依据公开文档，保守填写）：

| provider | visionTransports | 依据 |
| --- | --- | --- |
| minimax | `["openai", "responses"]` | 官方 `/anthropic` 兼容文档明确 image 不支持；视觉走 `/v1` |
| claude | `["anthropic"]` | 原生协议支持 base64 / url source |
| kimi | `["openai"]` | 仅 Chat Completions |
| doubao / mimo / chatgpt | 按官方文档逐个核实后填；未核实 = 空数组（保守） | — |
| unknown（自定义端点） | 空数组 | 保守，走 fallback |

**第 2 步：直发判定 + adapter 转换**。

1. `build-options.ts` 直发判定从「只看用户开关」改为「用户开关 AND 当前 transport ∈
   `visionTransports`」：

   ```ts
   const capability = getCapabilityOrOpenAI(settings.provider);
   const directVisionOk = primaryModelIsMultimodal
     && (capability.visionTransports ?? []).includes(effectiveTransport);
   // 不满足 directVisionOk 时与 multimodal=false 同路径：
   // 有独立视觉配置（visionBaseUrl / vision 模型）→ caption 降级；否则文本占位。
   ```

2. `anthropic-adapter.ts` 的 `toWireMessages` user 分支加块转换（给 claude 及未来
   支持 image 的 Anthropic 协议端点用；对不支持的端点，图片在第 1 步已被拦截，
   不会走到这里）：

   ```ts
   // OpenAI 风格 image_url → Anthropic image 块。
   // data URL → source.type=base64；http(s) URL → source.type=url（原生协议两者都支持）。
   function toAnthropicContent(content: ChatMessageContent): string | ContentBlock[] {
     if (typeof content === "string") return content;
     const blocks: ContentBlock[] = [];
     for (const block of content) {
       if (block.type === "text") {
         blocks.push({ type: "text", text: block.text });
       } else if (block.type === "image_url") {
         const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(block.image_url.url);
         if (dataMatch) {
           blocks.push({
             type: "image",
             source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] },
           });
         } else {
           blocks.push({
             type: "image",
             source: { type: "url", url: block.image_url.url },
           });
         }
       }
     }
     return blocks;
   }
   ```

3. MiniMax 用户带图 + 主协议 Anthropic 的**降级路径**：走现有
   `withCaptionedImageAttachments`（`build-options.ts:315-339`）——独立视觉模型
   （MiniMax 的 `visionBaseUrl` 指向 `/v1`，OpenAI 协议，天然能发 image_url）生成
   文字描述后进主模型。这正是能力表 `visionBaseUrl` 字段存在的意义，链路是现成的。
   若用户未配置视觉（或模型档案 multimodal 关），现状已是文本占位，维持。

**测试**：

1. `anthropic-adapter.test.ts`：data URL → `source.type=base64`；http URL →
   `source.type=url`。
2. `build-options.test.ts`：MiniMax + anthropic transport + 带图 → 不直发（走 caption
   或占位）；MiniMax + openai transport + 带图 → 直发 `image_url`；claude + anthropic
   → 直发并经 adapter 转成 `image` 块。
3. `capabilities.ts` 快照测试：`visionTransports` 各厂商初值符合上表。

**风险与验证**：MiniMax `/anthropic` 是否真的拒收 image block 以实测为准（公开文档
写不支持，但文档可能滞后）；即便实测拒收，本修法的行为（Anthropic 端点不直发）也
与文档一致，无需再改。对 MiniMax 用户的正确发图路径是 OpenAI 兼容入口直发，或
Anthropic 入口 + 独立视觉 caption——修完后两条都通。

> **2026-08-26 实测更新**：文档确实滞后。官方 `text-anthropic-api` 页已标注
> `type="image"` **仅 M3 支持**（JPEG/PNG/GIF/WEBP，URL 或 base64，≤10MB）。
> 已放开：MiniMax `visionTransports = ["anthropic", "openai", "responses"]`，
> 并在 `build-options.ts` 加 `visionTransportsForModel` 做模型级过滤——
> M3 三端点直发，M2.x 全端点不发图（官方明确 M2.x 不接受图片输入，直发必 400）。
> 用户实测路径「M3 + anthropic + caption 降级失败」即旧保守判定所致，非设置问题。
>
> **2026-08-26 终版决定（用户拍板）**：上述 capability 表方案上线前被推翻——
> 静态表永远滞后于服务端实际状态（本 bug 即为证），且用户既然能自己选
> provider/模型/多模态开关，就不需要本地防呆。**已删除 `visionTransports`
> 字段与 `visionTransportsForModel`**，直发判定只看用户开关
> （`directVisionOk = settings.multimodal !== false`）。
> 能力仲裁完全交给服务端：直发 400 且未流出内容时，chat-loop 用
> `imageCaptionFallback` 自动降级重试（配了独立视觉模型则用户无感）。
> 保留物：anthropic-adapter 的 `image` 块转换（协议序列化职责，非能力猜测）、
> `[image-send]` 链路日志、400 完整错误体日志。

---

## 问题 2（严重）：图片按 base64 文本计量 token，虚高约百倍，连带误触发自动压缩

> **✅ 已修**（2026-08-29 核实）：`orchestrator/context-manager.ts:47-70` 新增
> `estimateMessageContentTokens`——图片块不再按 base64 字符计，改用固定保守回退
> `DEFAULT_IMAGE_TOKEN_ESTIMATE = 4096`（单图现实区间 1k~5k，压缩安全判定宁高估不低估），
> `estimateMessageTokens` 与 `buildContextUsageSnapshot` 共用此函数，计量与压缩判定口径统一。

**现象**：带一张截图后，上下文环形图用量暴涨（长 JSON 占据夸张上下文）。

**根因**：计量层把图片块当普通文本估算。

1. `src/main/orchestrator/context-usage.ts:96-100`（`buildContextUsageSnapshot`）：

   ```ts
   const text = typeof message.content === "string"
     ? message.content
     : JSON.stringify(message.content);        // ← base64 全长进 text
   buckets[...] += estimateTokens(text) + 4;
   ```

2. `src/main/orchestrator/context-manager.ts:36-45`（`estimateTokens`）：ASCII 按 4 字符/token。
   一张 1MB PNG 的 base64 ≈ 137 万字符 → **显示约 34 万 token**。
3. `context-manager.ts:47-52`（`estimateMessageTokens`）同样问题——它喂给
   `compressConversation`（L85-88：`threshold = contextWindow * 0.8`）做压缩判定。
4. **真实计费**：API 对图片按视觉 token 计（千位数量级），估算与真实差两个数量级。
5. **连带伤害**：发一张图 → 环形图总量轻松越过 80% 阈值 → `compressConversation`
   **误触发自动压缩**，把不该压的对话压了。该因果链已完整闭环。

**修法**（统一 estimator + 保守回退，不绑定任何厂商旧公式）：

**首版（本次实施）**：

1. 新增单一实现（放 `context-manager.ts` 导出，`context-usage.ts` 复用）：

   ```ts
   // 保守固定回退值。协议 ≠ tokenizer：MiniMax 模型走 Anthropic 协议并不会
   // 因此使用 Claude 的视觉计费算法，故不绑定任何厂商公式。
   // 现实区间：主流多模态模型单图 1k~5k token；取 4096 保守偏高——
   // 压缩安全判定宁可高估，不可低估撞穿 context window。
   export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 4096;

   // 图片块不计 base64 字符串，text 块照常估算。两处计量共用，防止口径分裂。
   export function estimateMessageContentTokens(
     content: string | OpenAIContentBlock[],
   ): number {
     if (typeof content === "string") return estimateTokens(content);
     let sum = 0;
     for (const block of content) {
       if (block.type === "text") sum += estimateTokens(block.text);
       else sum += DEFAULT_IMAGE_TOKEN_ESTIMATE; // image_url 块
     }
     return sum;
   }
   ```

2. `estimateMessageTokens`（`context-manager.ts:47-52`）与
   `buildContextUsageSnapshot`（`context-usage.ts:96-100`）的消息循环统一改调
   `estimateMessageContentTokens`——**两处必须同步改**，否则计量与压缩判定口径分裂。
3. 修正前后对比：一张 1MB 图 340k → 4k。即使真实只按 1600 计费，多算 2.5k 也远好于
   现状多算 33.8 万；且压缩判定偏保守是安全方向的误差。
4. **注意**：请求体里 base64 仍原样发送（传输体积 ≠ 计费 token），本修法只改本地计量口径。

**后续增强（不在本次范围，记录方向）**：

- 按模型档案细分 estimator：Claude → `ceil(w/28) × ceil(h/28)` patch 算法（标准档
  上限约 1568，Claude 4.7+ 高分辨率档约 4784）；GPT / MiniMax 各自口径；未知 → 保守
  4096。形态可以是模型档案 `vision: { tokenEstimator: "anthropic-patch" }` 或
  `estimateImageTokens(block, { provider, model })`。
- PNG base64 头解析真实宽高（IHDR），供 estimator 使用。

**测试**：含一张 1MB base64 图片的消息估算 < 5k token（而非数十万）；
`estimateMessageTokens` 与 `buildContextUsageSnapshot` 对同一消息列表的 conversation
桶计量一致。

---

## 问题 3（中）：手动压缩后环形图不刷新，需再对话一次

> **✅ 已修**（2026-08-29 核实）：已按 v2 方案落地 session 级状态——
> `ChatPage.tsx:2282-2285` 环形图取值改为「session 级快照优先（手动压缩等不产生新消息的
> 操作也即时刷新），消息级快照兜底兼容旧数据」；配套实现见
> `docs/context-usage-viewer-construction-plan.md`。

**现象**：点环形图菜单里的"整理"压缩成功后，环形图数据不变；再发一条消息才更新。

**根因**：环形图数据寄生在 assistant 消息上，只在 LLM 请求轮次产出。

1. 前端：`ChatPage.tsx:1352-1360` 监听 `cyrene.context.usage` 事件，写入方式是
   `updateMessage(input.sessionId, input.assistantId, { contextUsage: snapshot })`——
   **依赖 AG-UI run 上下文的 `assistantId`**；`ChatPage.tsx:2183-2188` 环形图取
   `messages.findLast(...contextUsage)`——即最近一次 run 留下的快照。
2. 事件源头：`harness/cyrene-harness.ts:346-365` `emitContextUsage` 只在 run 的
   preRequest / terminal 阶段发。手动压缩不走 run → 没有新快照、也没有 assistantId。
3. 手动压缩 IPC（`chats/chats-ipc.ts:141-216`）完成后只 `broadcastChanged()`（L208）
   重载消息列表；没有任何代码重算 usage 并推送 → 环形图继续显示旧快照。
4. "只有触发聊天才更新"是同一根因：下一轮 run 的 preRequest 快照才反映压缩后状态。

**架构隐患**（外部 review 指出）：上下文用量本质是 **会话状态**，不是某条 assistant
消息的属性。寄生在消息上意味着任何「不产生新 assistant 消息但改变上下文构成」的事件
（手动压缩、切换模型、Skill/工具集变化）都会让 UI 过期。这个问题会反复出现。

**修法**（短期 hotfix + 长期方向分开）：

**短期（本次）——session 级最新快照**：

1. `CHATS_COMPACT` handler 在 `replaceMessages` 成功后，复用
   `buildContextUsageSnapshot` 对 `nextMessages` 算一份 `phase: "terminal"` 快照。
2. 推送方式不能照抄 harness 事件（前端 handler 需要 `assistantId`，手动压缩没有）：
   - 快照随 `broadcastChanged()` 的会话重载下发（session 对象带
     `currentContextUsage` 字段），或
   - 走独立 IPC 事件，前端在 run 监听器**之外**另接一个 handler 写入 session 级状态。
3. **前端必须改**（撤回 v1 的「无需前端改动」）：环形图取值逻辑从
   `messages.findLast(contextUsage)` 改为
   `session.currentContextUsage ?? messages.findLast(contextUsage)?.contextUsage`
   （session 级优先，消息级兜底兼容旧数据）。

**长期（记录方向，不在本次）**：

```ts
ConversationState {
  currentContextUsage: ContextUsageSnapshot;  // 环形图唯一读取点
}
// 消息上的 contextUsage 保留为历史快照，仅用于 debug / 对比。
```

run 轮次产生的快照同时写两处；所有改变上下文构成的操作（压缩/切模型/工具集变化）
只需更新 session 级状态。问题 3 这类 stale UI 从根上消失。

**测试**：`chats-ipc` 测试补断言——压缩成功后 session 携带反映压缩后消息列表的
快照（messageCount / tokens 与 `nextMessages` 对应）；前端环形图优先读 session 级。

---

## 问题 4（中）：截图功能半成品（四个子项）

> **✅ 已修**（2026-08-29 核实，按子项）：
> - 粘贴：`ChatComposer.tsx:283` `handlePaste` 已实现（区分文字/图片粘贴，不吞用户文字，委托 `handlePastedImage` 处理大小与临时文件）；
> - multimodal 默认关：已随 API 档案化解除（commit `5f5c7cd`），`orchestrator/build-options.ts:773` `settings.multimodal !== false` 才直发视觉，跟随档案显式关闭才不发；
> - 失败静默：发图链路补诊断日志（adapter `[image-send]` 三级统计 + commit `051d388` 截图捕获几何与后端诊断日志），不再无声失败。

| 子项 | 现状 | 结论 |
| --- | --- | --- |
| 输入框截图按钮 → 插入附件 | 已实现：`ChatComposer.tsx:359` → IPC → `ChatPage.tsx:564-578` 收 `SCREENSHOT_INSERT` 加附件 | 可用，但失败静默 |
| 热键截图 | `screenshot-service.ts:78-85` 设计为 clipboard-only，不插入对话框 | 设计行为，非 bug |
| Ctrl+V 粘贴图片 | renderer 无任何 paste 处理；主进程 `SCREENSHOT_SAVE_TEMP`（`screenshot-lifecycle.ts:114-116`）与 preload `saveScreenshotTemp` 已就绪但无人调用 | **未实现** |
| 普通 chat 只见文件路径 | `build-options.ts:749` `settings.multimodal !== false` 才直发图片；全局默认 false（`model-settings.ts:179`），按会话档案解析（`chat-ui-ipc.ts:182-199`）→ 走"独立视觉模型描述"降级，视觉模型未配置 → 只剩路径文本 | 配置问题 + 可加提示 |

**修法**：

1. **粘贴图片**（核心补齐，后端零改动）：
   - `ChatComposer.tsx` 输入元素加 `onPaste`：
     - **仅当剪贴板无 `text/plain` 且含 image 项时才 `preventDefault()`**——浏览器
       剪贴板常同时带 text/plain + text/html + image/png（复制网页富文本），
       粗暴拦截会把用户想粘的文字吃掉。
     - **MIME 白名单**：`image/png` / `image/jpeg` / `image/webp` / `image/gif`。
     - **大小限制**：主进程 `MAX_SCREENSHOT_BYTES = 20MB`
       （`screenshot-lifecycle.ts:24`）已有硬校验，前端提前检查文件大小并 toast 提示，
       避免白跑一趟 IPC。
     - 通过后转 base64 调 `window.chat?.saveScreenshotTemp(base64, mime)` 拿
       `filePath`，构造与 `ChatPage.tsx:566-573` 相同的 `ComposerAttachment`
       （kind: "image"）追加进当前 scope 附件列表。
   - 临时文件落在 `userData/screenshots/`（与按钮截图同目录），复用发送链路
     （`agent-input.ts:17-25` 按附件收集 imageAttachments）。
2. **截图失败提示**：`ChatPage.tsx:2363` `void window.chat?.startScreenshot()` 把
   `{ok, reason}` 静默丢弃。改为检查返回值，`ok === false` 时 toast 提示
   （reason 映射可读文案：helper 未就绪 / 截图失败等）。
3. **multimodal 开关**（配置项，不改代码）：设置 → 会话绑定模型档案 → 打开
   "主模型多模态"，chat 模式即直发图片。可选增强：档案未开多模态且未配置独立视觉
   模型时，发送带图消息前 UI 提示"当前配置无法看图"。注意与问题 1 修法联动：
   开关打开也只对 `visionTransports` 覆盖的协议直发（MiniMax 主协议 Anthropic 时仍走
   caption 降级，避免 400）。
4. **热键截图插入对话框**：维持现状（仅剪贴板）。若未来要改，在
   `screenshot-service.ts` 的 hotkey 路径复用 `clipboard-and-file` 模式即可，
   属产品决策。

---

## 实施顺序（按依赖关系）

```text
① capabilities.ts 加 visionTransports 维度（问题 1 第 1 步）
   ↓
② build-options 直发判定接入 capability（问题 1 第 2 步之 1）
   ↓
③ anthropic-adapter image 块转换（问题 1 第 2 步之 2，服务 claude 及未来端点）
   ↓
④ 统一 estimateMessageContentTokens + 保守 4096（问题 2）
   ↓
⑤ 压缩后 session 级快照 + 前端环形图取值改造（问题 3）
   ↓
⑥ paste 白名单/大小限制 + 截图失败 toast（问题 4）
```

①②③ 是一组（发图链路），④ 独立（计量），⑤ 独立（UI 状态），⑥ 独立（前端 UX）。
可按 ①→③ 一批、④ 一批、⑤⑥ 一批提交。

验证口径：`build:main` + `build:renderer` + 全量 vitest；MiniMax 实测两条路径
（OpenAI 入口直发、Anthropic 入口 caption 降级）各发一张图确认不再 400。
