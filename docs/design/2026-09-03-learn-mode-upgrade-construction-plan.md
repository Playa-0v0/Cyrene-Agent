# Learn 模式升级施工计划：抽查测试 + Mermaid 渲染 + 导学大纲

> 背景调研：借鉴 OpenMAIC（多智能体 AI 课堂）的设计，补强 Cyrene learn 模式的内容表现力。
> Cyrene 的差异化优势是"陪伴式辅导 + 掌握度闭环"（progress.md 追踪），本次升级在不破坏该定位的前提下，
> 引入 OpenMAIC 的交互练习与可视化能力。
> 姊妹篇：`2026-09-03-bilinote-video-notes-design-reference.md`（占位标记协议的出处）。
> 修订记录：2026-09-03 第二稿，吸收外部 review 意见（补 quiz 身份/知识点/证据/结果四契约、
> 导学跳过出口、SVG 安全层；砍预计投入、Mermaid v1 工具条、长期 10s 重播原则）。
> 2026-09-03 第三稿（施工前终稿）：卡片级跳过出口 + quiz 级 skipped 状态、
> ID 收归宿主生成（模型输入不含 id）、sourceRef 改为"出题前已读证据"、
> learningObjective 命名复用规范、顶层 PopQuizToolResult 闭合协议、
> Mermaid 大输入熔断、explanation 与 agent 讲评的职责分层。**设计到此冻结，
> 题库/难度分级/间隔重复/知识图谱/掌握度百分比/quiz 历史库均不进入本版。**
> 2026-09-05 增补稿：方案二新增 v2 扩展"SVG 学习卡片"（`cyrene-diagram` 技能 +
> `svg` 围栏渲染分支），借鉴 TRAE dynamic-ui 技能"提示词契约 + 渲染器"的分工方法论。
> 原冻结范围不变；SVG 卡片排在 Mermaid v1 之后实施，不挤占本版主线。

---

## 一、总体设计

三个功能互相独立可并行，但实施顺序建议 **方案一 → 方案二 → 方案三**（导学大纲的先修检测依赖 quiz 工具）。

```
方案一 pop_quiz 抽查工具     —— 掌握度闭环的数据源（复用 ask 卡片管线）
方案二 Mermaid 图渲染        —— 全模式受益的图表能力（beautiful-mermaid 引擎）
    └─ v2 扩展：SVG 学习卡片 —— 模型手写 SVG 卡片（cyrene-diagram 技能 + svg 围栏渲染）
方案三 导学大纲              —— 零新代码的提示词工程 + learn_system.md 事实优先修订
```

---

## 二、方案一：抽查测试工具 pop_quiz

### 2.1 定位与命名

- 工具名 `pop_quiz`（突击抽查），语义上是"老师考学生"，与 `ask` 的"向用户求助/征求偏好"方向相反
- **防混保险（比命名更重要）**：两工具描述互写分工说明——
  - pop_quiz 描述："测试**用户**对已学内容的掌握，出题并批改。不要用 ask 代替出题。"
  - ask 描述追加："向用户征求**偏好/确认**。不要用于出题测试用户。"
  - 傻子模型靠工具描述路由，不靠名字推断
- `modes: ["learn"]`（与 obsidian 工具同款限制，仅 learn 模式注册）

### 2.2 题型 schema：discriminated union（可辨识联合）

**不用万能 Question + answerIndex + allowMultiple**（会产生非法状态：multi 题一个 index 不够、
true_false 不需要 options、allowMultiple 与 type 职责重叠），直接按题型拆四个类型：

```ts
// 工具输入 schema（模型侧）——不含任何 id，id 由宿主生成（见 2.3）
type QuizQuestionInput = ChoiceInput | MultiInput | TrueFalseInput | ShortAnswerInput;

type ChoiceInput = {
  type: "choice";
  question: string;
  options: string[];          // A/B/C/D 四项
  correctIndex: number;
};

type MultiInput = {
  type: "multi";
  question: string;
  options: string[];
  correctIndexes: number[];   // 全对才对
};

type TrueFalseInput = {
  type: "true_false";
  question: string;
  correct: boolean;
};

type ShortAnswerInput = {
  type: "short_answer";
  question: string;
  referenceAnswer: string;    // 评分参考
  rubric: string[];           // 给分要点
};
```

公共字段（所有题型都有）：

```ts
{
  learningObjective: string;              // 本题测哪个知识点（见 2.2.1）
  explanation: string;                    // 错因讲解，批改后展示
  sourceRef?: { file: string; heading?: string };  // 题目材料出处（见 2.2.2）
}
```

v2 备选（v1 不做）：填空题（与多选交互重叠，收益低）、连线题（渲染复杂）。
限制：一次抽查 1-3 题（沿用 ask 卡片"最多 3 问"的约束）。

#### 2.2.1 learningObjective：掌握度闭环的关键契约

没有这个字段，learn-post-turn 只能"知道用户答错了，但猜不出哪个知识点没掌握"，
掌握度闭环只完成一半。每题必须声明测的知识点：

```json
{
  "question": "true + true 的结果是什么？",
  "type": "choice",
  "learningObjective": "JavaScript 中 + 对 boolean 的隐式类型转换"
}
```

作答结果直接成为 `objective + correct` 的实测数据，progress.md 不再靠猜。

**命名稳定性规范（防知识点名漂移）**：learningObjective 是自由字符串，长期会出现
"布尔值隐式转换 / boolean 的数值转换 / + 运算符的类型强制转换"三个名字指同一个知识点的情况。
不加 conceptId（过度设计），只在提示词里约定：

> 如果当前学习材料的 outline.md / progress.md 中已有知识点或章节名称，
> learningObjective 优先复用已有名称，不随意创造同义名称；只有遇到新的细分知识点时才新建描述。

这样 `outline.md → canonical learning objective → pop_quiz → progress.md` 的名字链保持稳定。

#### 2.2.2 sourceRef：出题前已读材料的证据指向

learn_system.md 要求"回到材料查证，不凭模型记忆"，quiz 出题同样遵守——
最恶劣场景：模型凭记忆出题且记错答案 → 本地判分立即显示"用户答错" → UI 已经红了，
模型事后才发现错在自己。**sourceRef 若只在争议后才查，挡不住这个场景。**

因此 sourceRef 的语义是"**答案从哪里来的**"（出题前已读取的证据），而不只是
"出争议以后去哪查"。配套提示词契约：

> 对 vault 材料中的具体事实出题时，必须先用 obsidian 工具读取对应材料，再构造题目及标准答案；
> sourceRef 只能引用本轮实际读取过的材料，不得凭记忆填写。

即出题流程是 `read material → derive question + answer → pop_quiz`，
而不是"凭记忆出题，事后出问题再查"。

附加边界说明：sourceRef 是逻辑引用，不是可信安全边界；主进程按 sourceRef 再次读取时
仍必须走 obsidian 工具现有的 vault 路径校验，不新造系统。

### 2.3 身份与幂等：ID 全部由宿主生成

已有 pending / 重播 / settle / run cleanup / renderer 恢复的设计，
幂等必须有 key，否则"用户点两次提交，到底 settle 哪次"无法回答。

**ID 归属宿主协议，不属于模型输入协议**——模型可能给出重复 id（两个 `"id": "1"`）
或无意义 id，它没有资格定义宿主的交互身份。流程：

```
LLM 提交 questions（不带 id）
    ↓ pop_quiz host handler
生成 quizId + 每题 questionId
    ↓ 建立 pending → 发 renderer（重播时 id 保持不变）
```

- 待入模型侧的输入类型即 2.2 的 `*Input`（无 id）；
  宿主内部类型为 `PendingQuizQuestion = *Input & { questionId: string }`
- 提交与 settle 均以 `quizId` 为幂等键，**重复提交只接受第一次**

### 2.4 端到端回路（关键设计：工具结果就是批改回路）

```
模型调用 pop_quiz（含题目 + 知识点 + 答案 + 讲解 + 出处）
    ↓ IPC
渲染端弹卡片（AG-UI 自定义事件，同 ask 卡片机制）
    ↓ 用户作答提交 / 点"跳过抽查"
主进程本地判分（选择/判断题）或原样打包（简答题）/ 结算 skipped
    ↓ 作为 pop_quiz 的 toolResult 回给模型
模型拿到结果 → 讲解错因 / 追问
```

#### 2.4.0 卡片级跳过出口（必须）

提示词层的"用户说别考了就停止"只管得住 **pop_quiz 调用之前**；一旦工具 Promise pending、
run 阻塞等 toolResult，用户再说"别考了"也未必能打断当前卡片。所以逃生口必须开在**卡片本身**：

- 卡片提供「跳过抽查」按钮，**整个 quiz 一次跳掉**（不给每题单独 skip）
- 提交 → settle `submitted`；跳过 → settle `skipped`，走同一结算管线
- `skipped` 不进入掌握度证据（跳过不是答错）

#### 2.4.1 结果结构：保留原始证据 + 三态批改状态 + quiz 级跳过

单题结果（grading 保持三态，**不为跳过加第四态**——跳过是 quiz 级状态，放外层）：

```ts
type QuizAnswerResult = {
  questionId: string;
  learningObjective: string;
  userAnswer: string | number | number[] | boolean;  // 原始作答
  correctAnswer?: string | number | number[] | boolean;  // 标准答案（简答题无）
  grading: "correct" | "incorrect" | "pending_model";
};
```

顶层 ToolResult（正式闭合整个协议：模型看到的完整对象）：

```ts
type PopQuizToolResult =
  | {
      quizId: string;
      status: "submitted";
      answers: QuizAnswerResult[];
    }
  | {
      quizId: string;
      status: "skipped";
    };
```

完整协议链：

```
Tool Input（无 id） → 宿主赋身份 → PendingQuiz → 用户交互（提交/跳过）
    → PopQuizToolResult → Agent → learn-post-turn
```

- **grading 用三态枚举，不用 `correct: null`**——null 以后分不清"尚未批改 / 无法批改 /
  用户跳过 / 发生错误"；简答题第一次返回统一 `pending_model`
- **保留原始证据而非只有对错**：multi 题"完全不知道"和"漏选了 C"是不同的掌握状态，
  本地判分仍简单（全对才 correct），但 post-turn 能看到"用户选中了 2/3 个正确项"
- **不做半分制 / 百分比掌握度**——那是过度设计，只保留原始证据

- 简答题第一次返回不带对错：agent 看到用户原文后自行批改讲评，
  **不再发第二个工具写回模型评分**（讲评文本和原回答一起进 post-turn 即可）
- 选择/判断题判分在主进程本地完成，不消耗模型
- 作答结果同步进入 learn-post-turn 输入，掌握度从"对话推断"升级为"实测数据"；
  **skipped 的 quiz 整体不进入掌握度证据**

**explanation 与 agent 讲评的职责分层**（防"答案解析说一遍、Cyrene 又复述一遍"的重复感）：

```
卡片 explanation = 标准答案为什么是对的（即时说明）
Agent follow-up  = 用户为什么会错 / 换角度讲解 / 追问（针对错误模式）
```

提示词约定：agent 拿到结果后不机械复述 explanation，而是根据用户的错误模式补充解释、
换角度讲解或追问。两层职责分开，正好贴合陪伴教学定位。

完整数据链：

```
材料 → learningObjective → pop_quiz → 用户行为证据（QuizAnswerResult）
     → learn-post-turn → progress.md
```

### 2.5 无超时实现（照抄审批流不变量）

复用 3baef6af 审批修复沉淀的模式，不走 `userChoiceTimeout` 老路：

- 不设 timer，pending 状态仅由用户提交或 run 终态（`cleanupRunState`）清理
- **v1 复用现有审批流 10s 幂等重播机制**（不为本功能单独重构审批基础设施）；
  长期架构方向是 renderer-ready 驱动的 pending interaction 同步
  （renderer ready / conversation activated → 请求当前 pending → main 返回），
  后续与审批流统一收敛，**10s 轮询不作为长期架构原则写死**
- 结算统一走 settle 函数 + 广播事件，渲染端持久监听清卡
- run 的 complete/error 终态必须清理 pending quiz，防止 promise 悬挂

### 2.6 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/main/orchestrator/` 新增 pop-quiz.ts | 工具定义 + 发布 + 结算（参照 ask-card.ts 结构） |
| `src/main/orchestrator/ask-card.ts` | 工具描述追加防混说明 |
| `src/main/agui-bridge.ts` | pop_quiz 事件接入 + run 终态清理 |
| `src/renderer/react/features/chat/components/InteractionPanel.tsx` | quiz 展示态：选项点选后高亮对错、显示 explanation、「跳过抽查」按钮 |
| `src/main/learn/progress/learn-post-turn.ts` | 作答结果（含 learningObjective）接入掌握度提取输入，skipped 不计入 |
| `prompts/learn_system.md` | 抽查交互约定（见 4.1） |

抽查交互约定写进 learn_system.md：一次抽查 1-3 题、答完必须讲解错因（不机械复述
explanation，针对用户错误模式讲解）、答错不责备但必须指出理解偏差、
**出题前先读材料（sourceRef 只引用本轮实际读取过的内容）**、
learningObjective 优先复用 outline/progress 已有命名、
**用户明确说"别考我了 / 直接讲"时立即停止抽查**、避免每轮测验。
（提示词层的停止约定只是第一道闸，pending 中的逃生口在卡片按钮，见 2.4.0。）

---

## 三、方案二：Mermaid 图渲染

### 3.1 引擎选型：beautiful-mermaid

验证结论（2026-09-03）：lukilabs 出品，同步渲染 `renderMermaidSVG()`，无 DOM 依赖，
15+ 内置主题 + 主色调自动配色，支持 flowchart / sequence / state / class / ER / xychart 子集。
无 mindmap / gantt / gitGraph / kanban。

选它而非官方 mermaid 的理由：

1. 设计基因对味（官方默认样式"理工直男风"，调教成本高）
2. 轻量：同步渲染、无需懒加载整套 runtime
3. 失败兜底简单：try/catch 降级显示源码

### 3.2 架构（含 SVG 安全层）

```
XMarkdown code 渲染器分流
    ↓ language === "mermaid"
MermaidBlock 组件
    ↓ streaming === true 时显示占位（见 3.3）
renderMermaidSVG(code) → SVG 字符串
    ↓ DOMPurify sanitize（必须，见 3.2.1）
    ↓ dangerouslySetInnerHTML + Cyrene 主题
聊天气泡内渲染
```

#### 3.2.1 SVG sanitize：必须的安全层

Mermaid 内容本质是 LLM 输出，属于不可信输入，直接 `dangerouslySetInnerHTML`
注入前必须过 DOMPurify 消毒（项目已有 `dompurify@^3.4.12` 依赖，零新增成本）。
即便 beautiful-mermaid 内部已做转义，这层仍作为纵深防御保留，并配测试覆盖：
`<script>` 注入、`onload=` 事件属性、`javascript:` 协议、`foreignObject` 逃逸。

#### 3.2.2 v1 范围（最小可用）

真正有技术风险的是渲染兼容性、SVG 安全和流式，工具条不是。v1 只做：

```
MermaidBlock v1
├─ SVG 渲染 + DOMPurify
├─ 错误降级（源码块 + "该图类型暂不支持"提示）
└─ 基础自适应宽度

v1.1（后置）
├─ 复制源码
└─ 全屏查看
```

主题：Cyrene 粉白主题（light 优先；dark 模式当前不维护，暂不做，留扩展点）。
兜底导流：语法不支持时提示"用 skill 画专业图表"，深度绘图需求导流给未来的绘图 skill。

### 3.3 流式处理：复用现有 streaming 状态，不造解析器

**不自己维护 Markdown fence parser**。`MarkdownContent` 已接收 `streaming` prop
（ChatMessageList.tsx），直接用它：

```
streaming === true → MermaidBlock 显示"图表生成中…"占位
streaming 结束     → 正式渲染 mermaid
```

整个流式阶段不渲染图也没关系——几秒后完整出来，远好过一边生成一边报 Syntax error 闪烁。

### 3.4 提示词约束

各模式系统提示词加一句硬性约束：

> Mermaid 图仅使用 flowchart、sequenceDiagram、stateDiagram、classDiagram、erDiagram 五类，
> 不要输出 mindmap / gantt / gitGraph / kanban 等扩展类型。

### 3.5 落地节奏：先 PoC

PoC 验证项（工具条不在内）：

- 能渲染（五类图各一张）
- 中文正常
- Cyrene 粉白主题定制效果
- 流式不炸（占位 → 完整渲染）
- 错误能降级
- bundle 体积增量
- **大输入同步渲染耗时**：beautiful-mermaid 是同步渲染，跑在 renderer UI 线程，
  LLM 理论上可吐出几百 KB / 几千节点的源码把 UI 卡死。
  PoC 顺手测大输入耗时；**若同步渲染存在明显 UI 阻塞，v1 增加源码长度熔断
  （超限直接降级源码块），不引入 Worker / 异步渲染服务**——先测再决定，最小保护

PoC 通过再正式做组件。

### 3.6 改动文件清单

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 beautiful-mermaid 依赖 |
| `src/renderer/react/features/chat/components/ChatMessageList.tsx` | code 渲染器分流 mermaid 分支 |
| `src/renderer/react/features/chat/components/` 新增 MermaidBlock.tsx | 渲染组件 + sanitize + 降级 |
| `prompts/` 各模式系统提示词 | mermaid 语法子集约束 |

### 3.7 v2 扩展：SVG 学习卡片（cyrene-diagram 技能 + svg 围栏渲染）

> Mermaid 是"结构化 DSL → 引擎渲染"，SVG 学习卡片是"**模型手写 SVG → 直接渲染**"。
> 后者表现力不受五种图型限制，能产出 Mermaid 画不出来的自由布局——
> 比如导学大纲的三列卡片、知识依赖的分层卡片、对比矩阵。
> 方法论出处：TRAE 的 dynamic-ui 技能（提示词契约 + 渲染器的两半分工），
> 移植其设计契约，但技能本体为 Cyrene 自研，不复制第三方文件。

#### 3.7.1 能力构成：一半提示词，一半渲染器

```
cyrene-diagram 技能（skills/cyrene-diagram/SKILL.md，自研，cyrene-* 前缀）
    —— 教模型"怎么画"：主题 token、布局规则、防重叠约束、复杂度预算
渲染端 svg 围栏分支（ChatMessageList code 渲染器，与 MermaidBlock 同构）
    —— 负责"安全显示"：DOMPurify 消毒 + 长度熔断 + 流式占位 + 失败降级
```

技能是纯提示词工程，不依赖任何工具；渲染分支复用 3.2 架构，
**sanitize / 熔断 / 流式占位 / 降级四层全部照抄 MermaidBlock，零新增安全面**。

#### 3.7.2 与 Mermaid 的分工（提示词层路由）

| 场景 | 用哪个 | 理由 |
|---|---|---|
| 流程图、时序图、状态图等标准结构 | Mermaid | DSL 短、引擎保证布局质量 |
| 导学大纲、章节依赖、对比矩阵、总结卡片 | SVG 学习卡片 | 自由布局，卡片式信息组织 |
| 数据趋势、精确图表 | 两者都不用（v2 冻结） | 引图表库是另一个决策，不搭车 |

判定原则写进 cyrene-diagram 技能描述：**能用 Mermaid 图型表达的结构化关系优先用 Mermaid；
只有当信息组织方式是"卡片/分层/矩阵"而非"节点+连线"时才手写 SVG**。

#### 3.7.3 渲染侧：svg 围栏分支

- code 渲染器分流新增 `language === "svg"` 分支 → `SvgCardBlock` 组件
- 流式阶段同 Mermaid：`streaming === true` 显示"卡片生成中…"占位，
  避免半截 SVG 反复解析报错闪烁
- **长度熔断阈值单独设定**：手写 SVG 比 Mermaid 源码更冗长（每个节点都是显式标签），
  熔断阈值可放宽到 Mermaid 的 2-3 倍，但超限同样降级为源码块
- DOMPurify 消毒规则与 3.2.1 完全一致（`<script>`、事件属性、`javascript:` 协议、
  `foreignObject`），测试用例直接复用同一组恶意输入样本

#### 3.7.4 提示词侧：cyrene-diagram 技能设计契约

技能文件 `skills/cyrene-diagram/SKILL.md`（YAML frontmatter + 正文，仓库自研技能格式），
`modes` 不设限（全模式可用，同 Mermaid）。核心契约从 dynamic-ui 提炼，适配 Cyrene 粉白主题：

**主题 token（写死在技能正文中，模型每次照抄；色值摘自 react-root.css 的 --cy-* token，
与全局 UI 一致，不另造色板）**：

```
卡片背景 #FFFBFC（--cy-bg-workspace）/ 次级表面 #FFF1F6（--cy-bg-hover）
强调主色 #FF5B8A（--cy-accent，Cyrene 粉）
文字 #1D1D1F（--cy-text）/ 次要文字 #8E8E93（--cy-text-muted）/ 边框 #F2F2F2（--cy-border）
圆角 12px（卡片）/ 8px（节点）/ 正文 ≥14px / 说明文字 ≥12px（字号下限，不许缩小硬塞）
```

**布局铁律（防重叠/防穿线/防溢出）**：

1. 画图前先在内部做坐标规划：每行节点总宽 + 间距 ≤ viewBox 宽度，放不下就换行或砍内容
2. 同行节点间距 ≥32，流程步骤间距 ≥60；节点宽 ≥ 文字宽 + 24 内边距
3. 连线不穿过任何节点和文字；标签放不下就改写节点副标题，不缩小字号
4. viewBox 固定 `0 0 720 H`，宽度自适应 100%，高度按内容计算
5. 卡片/容器四周留内边距，文字不贴边

**复杂度预算（防模型手抽风画 50 个节点）**：

```
单张 SVG ≤ 6 个未分组节点 / ≤ 8 条连线；超过就分组、拆多张、或改用 Markdown 列表
每张卡片一个视觉焦点；水平方向最多 4 个盒子；信息塞不下 = 内容该精简，不是图该变大
```

**输出纪律**：

- 只输出静态 SVG：无 `<script>`、无事件属性、无外部资源引用（这些会被 sanitize 拦掉，
  写了也白写，还污染降级源码）
- SVG 代码放在 ` ```svg ` 围栏中输出，围栏外不解释坐标细节
- 一次回复最多 1 张 SVG 卡片（多张连发说明内容该用文字组织）

#### 3.7.5 首个场景：导学大纲卡片化（联动方案三）

方案三的导学大纲目前是纯文本 outline.md。SVG 卡片就绪后升级为：

```
outline.md（事实存储，不变）
    ↓ 导学流程第 2 步生成大纲时
同一回复内附一张 SVG 学习卡片（材料概览 / 章节依赖 / 建议起点三栏）
    ↓ outline.md 仍是唯一事实源
SVG 卡片只是呈现层，用户确认起点仍以文字对话进行
```

**不改变方案三的零代码属性**（方案三先行落地时大纲就是纯文本，卡片是后续增强，
outline.md 结构和导学流程完全不用改）。

#### 3.7.6 v2 明确不做

| 不做 | 理由 |
|---|---|
| 脚本交互（hover/toggle） | 聊天气泡内 SVG 是静态快照，交互能力收益低且 sanitize 必然拦 |
| 暗色主题 | 同 Mermaid 决策，dark 模式当前不维护 |
| 图表库（Chart.js 类） | 引库是独立决策，且数据图表应该走 Mermaid xychart |
| Worker 渲染 | 手写 SVG 受复杂度预算限制（≤6 节点），长度熔断兜底足够 |
| 每 SVG 单独配置主题 | token 写死在技能里，保持全局一致 |

#### 3.7.7 改动文件清单

| 文件 | 改动 |
|---|---|
| `skills/cyrene-diagram/SKILL.md` 新增 | 自研技能：主题 token + 布局铁律 + 复杂度预算 + 分工路由 |
| `src/renderer/react/features/chat/components/ChatMessageList.tsx` | code 渲染器新增 svg 分支 |
| `src/renderer/react/features/chat/components/` 新增 SvgCardBlock.tsx | 渲染组件，四层保护照抄 MermaidBlock |
| `prompts/learn_system.md` | 导学流程第 2 步追加"生成大纲时附 SVG 学习卡片"约定 |

---

## 四、方案三：导学大纲 + learn_system.md 修订

### 4.1 learn_system.md 事实优先原则（本次修订的核心）

learn 模式人设当前最大的隐患是"迎合用户"：模型可能因迎合心理或幻觉，
肯定用户的错误理解，让用户在错误道路上越走越远。加一段：

> **事实优先原则**：你是学习陪伴，不是情绪陪伴。
> 当用户的理解与材料事实冲突时，必须指出并引用材料原文，不能迎合用户的错误理解；
> 不确定的事实必须说"我不确定"，并回到 vault 材料里查证（用 obsidian 工具），
> 不能凭模型记忆编造；用户的猜测被材料支持时才肯定，被材料否定时要明确说"材料里不是这样"。

与 learn_identity.md 的"不责备答错"不冲突：对人是暖的，对事实是硬的。
quiz 的 sourceRef（2.2.2）是同一原则在出题侧的落地。

### 4.2 首课导学流程（零新代码）

**触发条件（收紧）**：不是"首次对材料说想学"，而是用户明确表达
**课程式意图**（"系统学习 / 从头学 / 带我学这份材料"）时才走导学。
用户只是问某个知识点，不能被识别成"要正式学习整份材料"。

**跳过出口（必须）**：用户说"直接讲 / 不用测试 / 从第 X 节开始"时，
立即跳过导学或先修测试，不得强制执行流程——导学是服务不是仪式。

导学三步：

1. **通读扫描**：用 `obsidian_list_files` / `obsidian_read_file` 快速扫材料结构（标题树、篇幅）
2. **生成大纲**写入 `learn/outline.md`，固定结构：
   - 这份材料讲什么（3 句话概括）
   - 分几节、每节解决什么问题、**前后依赖是什么**（如"第 3 节：理解对象——建议先掌握函数"）
     ——不写"预计投入时间"，模型根本不知道用户学多久，依赖关系比时间预测有价值
   - 先修检测：3 个快速问题判断用户基础（联动 pop_quiz，大纲生成完直接弹先修测试）
   - 建议起点：从第几节开始、为什么
   - 呈现层：方案二 v2 的 SVG 学习卡片就绪后，生成大纲的同时附一张
     大纲卡片（见 3.7.5）；未就绪前纯文本即可，outline.md 结构不变
3. **等用户确认**：用户回复"从第 2 节开始"或"基础可以，直接讲核心"后，进入现有陪伴模式

**"首次"的判定：利用现有文件即状态，不加数据库字段**：

```
progress.md 存在有效学习记录 → 续学
outline.md 已存在           → 使用已有大纲（跳过生成，但仍可跳过先修测试）
两者都没有                   → 首次导学（且仅在课程式意图下触发）
```

### 4.3 改动文件清单

| 文件 | 改动 |
|---|---|
| `prompts/learn_system.md` | 事实优先原则 + 首课导学流程（含触发条件收紧与跳过出口）+ 抽查交互约定 |
| `src/main/learn/obsidian/vault-templates.ts` | outline.md 模板 |

---

## 五、实施顺序与验证

```
第一步：pop_quiz 工具（主进程管线 → 渲染卡片 → 掌握度接入）
第二步：Mermaid PoC → 通过后做 MermaidBlock（可与第一步并行启动）
第三步：learn_system.md 修订 + 导学大纲（依赖第一步的 quiz 工具）
第四步：SVG 学习卡片（依赖第二步的 MermaidBlock：复用 sanitize / 熔断 /
    流式占位 / 降级四层，先写 cyrene-diagram 技能再做 SvgCardBlock）
```

每步验证标准：

- pop_quiz：learn 模式出题 → 作答 → 判分回传（含 learningObjective + 原始证据）→
  agent 讲解全链路跑通；**卡片「跳过抽查」能结算 skipped 且不进掌握度证据**；
  幂等（quizId 重复提交只结算第一次）与无超时不变量
  （终态清理 / 重播 / 广播清卡）有测试覆盖
- Mermaid：learn 模式让 Cyrene 画流程图 → 流式占位 → 完成后气泡内渲染成功 →
  恶意 SVG 输出被 sanitize 拦截 → 语法不支持时优雅降级
- 导学：新 vault 放入材料 → 课程式意图触发大纲生成（含依赖关系）→ 先修测试弹出 →
  "直接讲"能跳过 → 确认起点进入陪伴模式；问单点知识不触发导学
- SVG 学习卡片：导学流程生成大纲 → 回复内 SVG 卡片正常渲染（粉白主题、无重叠穿线）→
  恶意 SVG 同组样本被拦截 → 超长 SVG 熔断降级源码块 → 模型在标准流程图场景
  正确路由到 Mermaid 而不是手写 SVG

---

## 附：设计原则备忘（来自 review 的取舍记录）

| 决策 | 理由 |
|---|---|
| learningObjective / questionId / sourceRef / 原始证据：加 | 掌握度闭环的四个契约，缺一环则闭环不完整 |
| discriminated union 替代万能 schema：加 | 减少设计而非增加设计，消除非法状态，删掉 allowMultiple |
| 卡片级跳过 + quiz 级 skipped 状态：加 | 提示词层的停止管不住 pending 中的 run；逃生口必须在卡片上 |
| ID 由宿主生成，模型输入不含 id：加 | 模型给不出可靠身份；id 属宿主协议不属于输入协议 |
| sourceRef = 出题前已读证据：改 | 争议后才查挡不住"本地判错已显示"；read → derive → quiz 才是事实优先 |
| learningObjective 命名复用 outline/progress：加（仅提示词） | 防名字漂移；不加 conceptId |
| 顶层 PopQuizToolResult：加 | 把已隐含存在的协议正式闭合，非新增设计 |
| explanation 与 agent 讲评分层：加（仅提示词） | 卡片讲"答案为什么对"，agent 讲"你为什么错"，防复述感 |
| Mermaid 大输入熔断：PoC 先测，必要时加 | 同步渲染在 UI 线程，超长源码会卡死；长度熔断是最小保护，不上 Worker |
| 10s 重播：v1 复用，标注收敛方向 | 不为 quiz 单独重构审批基础设施，轮询不写成长期原则 |
| SVG sanitize：加 | LLM 输出是不可信输入，DOMPurify 已有零成本 |
| 复制/全屏：v1.1 后置 | 技术风险在渲染与安全，不在工具条 |
| 预计投入：删 | 模型不知道用户学多久，前后依赖更有价值 |
| 半分制/百分比掌握度：不做 | 过度设计，保留原始证据即可 |
| 简答题二次工具写回评分：不做 | 讲评文本进 post-turn 即可 |
| 新数据库字段/学习 session 系统：不加 | 用现有文件（outline.md / progress.md）即状态 |
| 题库/难度分级/间隔重复/知识图谱/quiz 历史库：冻结不做 | 当前闭环已完整，设计到此为止 |
| SVG 学习卡片（cyrene-diagram + svg 围栏）：加（v2，第四步） | 卡片式信息组织是 Mermaid 画不出的；四层保护照抄 MermaidBlock 零新增安全面 |
| 复制 dynamic-ui 技能文件本体：不做 | 移植设计契约（token/布局铁律/复杂度预算），技能按 cyrene-* 自研规范重写，避免第三方快照约束 |
| SVG 卡片脚本交互/图表库/暗色主题：不做 | 静态快照够用；引库是独立决策；dark 模式当前不维护 |
| SVG 卡片排版校验器（解析 SVG 查重叠）：不做 | 提示词层布局铁律 + 复杂度预算（≤6 节点）约束模型输出；机器校验是过度设计 |
