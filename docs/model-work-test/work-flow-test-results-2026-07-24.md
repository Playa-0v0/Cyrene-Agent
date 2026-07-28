# Cyrene 厂商模型 Work 流程实测结果

> 测试日期：2026-07-22  ----  2026-07-24
> 测试范围：CITA → Action Gate → Native Function Calling → 无副作用 Tool Runtime → Soul  
> 撰写：Playa
> 备注：本项目为个人业余学习开发项目，无协作团队；文档完整记录全链路细节，不做精简压缩，用于长期留存测试标准、链路逻辑，避免长期搁置后遗忘流程与判定规则。

## 1. 测试方法

所有模型使用同一套固定变量：

- 用户请求：将刚才展示项目的优先级设置为高。
- 上下文：当前会话中存在一个真实、未过期的项目引用。
- Action Gate capability：`project.priority.set`
- Native FC 期望参数：可信项目引用 + `priority=high`
- Tool Runtime：无副作用测试工具。
- 成功标准：
  1. Action Gate 生成可信 `act` 决策；
  2. Native FC 返回唯一有效的真实 tool call；
  3. 参数引用真实且优先级为 `high`；
  4. Tool Runtime 恰好执行一次；
  5. Soul 根据真实执行结果生成最终回复。

`Soul 到达` 与 `完整 Work 成功` 分开统计。前置阶段失败后进入 Failure Soul，也计为 Soul 到达，但不计为工具执行成功。

- 2026-07 测试流程如下：

```
用户输入
  ↓
运行模式判断
  ├─ Chat
  │    ├─ 不调用 CITA
  │    ├─ 不调用 Action Gate
  │    ├─ 不进入 Native Function Calling
  │    ├─ 不暴露或执行任何工具
  │    └─ 最近消息 + 社交上下文原子 + 用户风格
  │         → Soul
  │         → AG-UI 返回用户
  │
  └─ Work
       ↓
     CITA 上下文理解
     输入：
       ├─ 用户原始请求
       ├─ 最近会话
       ├─ 当前会话上下文
       └─ 真实、未过期的 contextRef
       ↓
     按厂商 / 模型选择 Structured Output Profile
       ├─ A：provider_json_schema
       ├─ B：provider_json_object
       ├─ M：MiniMax M3 专用适配
       └─ D：prompt_json
            （自定义端点、本地模型、未知型号固定 D 档）
       ↓
     统一 Structured Output Pipeline
       ├─ normalize
       │    ├─ 分离 reasoning_content / thinking
       │    ├─ 提取正文 content
       │    ├─ 剥离 Markdown / JSON 代码围栏
       │    └─ finish_reason 归一化
       │         ├─ complete → 继续解析
       │         ├─ truncated → 进入协议 repair
       │         └─ refused / content_filter / 请求错误
       │              → 不 repair，直接安全降级
       │
       ├─ JSON 候选提取
       │    ├─ 整体直接 JSON.parse
       │    ├─ 提取代码块内容
       │    └─ 字符串感知的括号配平扫描
       │
       ├─ 候选去重
       └─ 只接受唯一符合 CITA Schema 的对象
       ↓
     CITA 三层校验
       ├─ 格式校验
       ├─ Schema 校验
       └─ 业务可信校验
            ├─ contextRef 是否真实存在
            ├─ 是否属于当前会话
            ├─ 是否已经过期
            └─ 指代是否能够唯一消歧
       ↓
       ├─ 通过
       │    → Trusted TurnUnderstanding
       │    → contextualizedQuery + trustedRefs
       │
       └─ 失败
            ├─ JSON / Schema / 截断错误
            │    → CITA 协议 repair
            │         ├─ 首次输入：必要上下文 + Schema + 错误码
            │         ├─ 第二次输入：最小上下文
            │         └─ 最多 2 次总请求，且受 Profile 时间预算限制
            │
            ├─ 缺少用户信息
            │    → 生成缺失事实，供后续 ask_user
            │
            └─ 请求失败 / 拒绝 / 过滤 / repair 耗尽
                 → CITA unavailable
                 → 不阻断 Work
                 → 保留原始用户请求继续后续流程
       ↓
     Action Gate 决策
     输入：
       ├─ originalQuery
       ├─ contextualizedQuery
       ├─ availableCapabilities
       ├─ trustedRefs
       └─ CITA 可信上下文
       ↓
     按相同厂商 / 模型 Profile
     再次进入统一 Structured Output Pipeline
       ├─ normalize
       ├─ finish_reason 检查
       ├─ 提取全部 JSON 候选
       ├─ 候选去重
       └─ 只接受唯一符合 ActionDecision Schema 的对象
       ↓
     Action Gate 三层校验
       ├─ 格式校验
       ├─ Schema 校验
       └─ 业务可信校验
            ├─ decision 是否为 respond / ask_user / act
            ├─ capability 是否在本轮可用集合
            ├─ targetRefs 是否真实、未过期
            ├─ 引用是否属于当前会话
            ├─ 是否存在歧义
            └─ 是否编造未提供的对象或能力
       ↓
       ├─ 通过
       │    → TrustedActionDecision
       │
       └─ 失败
            ├─ JSON / Schema / 截断错误
            │    → Action Gate 协议 repair
            │         ├─ 原始机器输入 + Schema + 错误码
            │         ├─ 第二次使用最小可信输入
            │         └─ 最多 2 次总请求，且受 Profile 时间预算限制
            │
            └─ 请求失败 / 拒绝 / 过滤 / repair 耗尽
                 → 本地生成 TrustedFailureFact
                 → toolExecuted: false
                 → 进入 Failure Soul
       ↓
     确定性决策路由
       ├─ decision = respond
       │    → Soul 根据可信上下文生成普通回复
       │
       ├─ decision = ask_user
       │    → Soul 根据缺失事实生成追问
       │
       ├─ decision = act
       │    ↓
       │  Native Function Calling
       │    ├─ 只暴露 Action Gate 选中的一个真实工具
       │    ├─ 注入可信 executionBrief
       │    ├─ 强制指定该工具
       │    └─ 只接受唯一真实 tool call
       │         ↓
       │         ├─ 返回有效 tool call
       │         │    → 参数格式校验
       │         │    → targetRef 可信校验
       │         │    → capability 一致性校验
       │         │
       │         └─ 未返回或参数无效
       │              → Native FC 专用 repair
       │              → 最多 1 次 repair
       │              → 仍失败：
       │                   ├─ 本地生成失败事实
       │                   ├─ toolExecuted: false
       │                   └─ 进入 Failure Soul
       │
       │  有效 tool call
       │    ↓
       │  Execution Policy
       │    ├─ 工具是否启用
       │    ├─ capability 是否允许
       │    ├─ 权限检查
       │    ├─ 用户授权检查
       │    ├─ 风险检查
       │    ├─ 引用状态检查
       │    └─ 幂等 / 重复执行检查
       │         ↓
       │         ├─ 不允许
       │         │    → toolExecuted: false
       │         │    → Soul 说明限制或请求授权
       │         │
       │         └─ 允许
       │              → Tool Runtime 执行真实工具
       │              → 获取真实 Tool Result
       │              → 写入执行账本
       │              → Soul 只根据真实执行结果回复
       │
       └─ outcome = failure
            → Failure Soul
            → 只接收本地可信失败事实
            → 禁止声称工具已经执行
       ↓
     Soul 输出最终回复
       ↓
     AG-UI 渲染
       ├─ 文本消息
       ├─ 工具卡片
       ├─ 执行状态
       └─ 失败 / 授权提示
       ↓
     返回用户
       ↓
     全过程结构化指标
       ├─ provider / model
       ├─ profile / tier / mode
       ├─ stage
       ├─ attempts / repairCount
       ├─ finishReason
       ├─ candidateCount
       ├─ validationFailureCode
       ├─ finalOutcome
       ├─ toolExecuted
       └─ latency
CITA 可以失败后降级继续；Action Gate、Native FC 和 Execution Policy
任何一层不可信，都必须禁止工具执行，并由 Soul 基于本地可信事实诚实回复。  
```


## 2. 总览

| 厂商 / 模型 | 档位 | 轮数 | 完整 Work | Soul 到达 | 平均耗时 | 结论 |
|---|---:|---:|---:|---:|---:|---|
| DeepSeek `deepseek-v4-flash` | B | 10 | 10/10 | 10/10 | 4.57s | 稳定、快速 |
| DeepSeek `deepseek-v4-pro` | B | 10 | 10/10 | 10/10 | 12.27s | 稳定|
| 豆包 `doubao-seed-2-1-turbo` | A | 10 | 10/10 | 10/10 | 16.65s | 稳定 |
| 豆包 `doubao-seed-2-1-pro` | A | 10 | 10/10 | 10/10 | 28.22s | 极其慢 |
| Qwen `qwen3.7-max` | B | 10 | 10/10 | 5/5 | 6.83s | 稳定、较快 |
| Qwen `qwen3.7-max` | B | 10 | 10/10 | 10/10 | 5.87s | 稳定、较快 |
| MiMo `mimo-v2.5` | B | 10 | 10/10 | 10/10 | 7.50s | 稳定 |
| MiMo `mimo-v2.5-pro` | B | 10 | 10/10 | 10/10 | 8.71s | 稳定 |
| Kimi `kimi-k2.6` | A | 10 | 10/10 | 10/10 | 14.15s | 稳定 |
| Kimi `kimi-k2.7-code`（普通 API） | A | 8 | 8/8 | 8/8 | 25.89s | 工具链稳定，CITA 较慢 |
| Kimi `kimi-for-coding`（TokenPlan/k2.7-code） | A | 10 | 0/10 | 10/10 | 13.34s | 不适合作为 Work 工具端点 |
| MiniMax `MiniMax-M3` | M | 10 | 10/10 | 10/10 | 10.61s | 专用 M 档后稳定 |
| GLM `glm-5.1` | B | 5 | 5/5 | 5/5 | 12.59s | 稳定，偶发 CITA 请求失败可降级 |
| GLM `glm-5.2` | B | 5 | 4/5 | 5/5 | 11.57s | 基本稳定，观察到一次 Action Gate 请求超时失败 |
| GLM `glm-4.7` | B | 5 | 0/5 | 4/5 | 23.23s | 响应过慢，不建议作为当前 Work 默认模型 |
| GPT 系列 | A | — | 未测试 | 未测试 | — | 本轮决定不测 |
| Claude 系列 | A | — | 未测试 | 未测试 | — | 本轮决定不测 |

- D档为本地与未知第三方平台兜底适配，本项目不做支持推荐

## 3. 分模型结果（仅摘要部分关键）

### 3.1 DeepSeek V4 Flash

- Profile：B 档 `provider_json_object`
- CITA：10/10 首次通过，repair=0
- Action Gate：10/10 首次通过，repair=0
- Native FC：10/10 参数正确
- Tool Runtime：10/10，每轮恰好执行一次
- Soul：10/10
- JSON、Schema、请求、限流错误：0
- 耗时：平均 4.57s，最短 4.12s，最长 5.27s

结论：本轮综合稳定性和速度最佳。

### 3.2 豆包 Seed 2.1 Turbo

- 测试 Model ID：`doubao-seed-2-1-turbo-260628/doubao-seed-2-1-pro-260628`
- Profile：A 档 `provider_json_schema`
- CITA：10/10 首次通过，repair=0
- Action Gate：10/10 首次通过，repair=0
- Native FC：10/10 参数正确
- Tool Runtime：10/10
- Soul：10/10
- 错误：0
- 耗时：平均 16.65s，最短 13.30s，最长 25.36s

方舟 Model ID 可能因用户部署不同而变化。项目现在只要求安全前缀边界 `doubao-seed`，支持任意 `doubao-seed-*` 后缀，不误匹配 `doubao-seeding-*`。

### 3.3 Qwen 3.7 Max

- Profile：B 档 `provider_json_object`
- CITA：10/10 首次通过，repair=0
- Action Gate：10/10 首次通过，repair=0
- Native FC：10/10 参数正确
- Tool Runtime：10/10
- Soul：10/10
- 错误：0
- 耗时：平均 6.83s，最短 6.01s，最长 7.90s



### 3.4 MiMo 2.5

- Profile：B 档 `provider_json_object`
- CITA：10/10 首次通过，repair=0
- Action Gate：10/10 首次通过，repair=0
- Native FC：10/10 参数正确
- Tool Runtime：10/10
- Soul：10/10
- 错误：0
- 耗时：平均 7.50s，最短 6.87s，最长 9.44s

结论：无需增加厂商专用适配。

### 3.5 Kimi K2.6

- Profile：A 档 `provider_json_schema`
- CITA：10/10 首次通过，repair=0
- Action Gate：10/10 首次通过，repair=0
- Native FC：10/10 参数正确
- Tool Runtime：10/10
- Soul：5/5
- 错误：0
- 耗时：平均 14.15s，最短 10.34s，最长 18.18s

结论：当前固定 Work 用例中，K2.6 比 K2.7 Code 更快、更稳定，无需额外协议适配。

### 3.6 Kimi K2.7 Code（普通 Moonshot API）

- Base URL：`https://api.moonshot.cn/v1`
- Profile：A 档 `provider_json_schema`
- 完整 Work：8/8
- CITA：2/8 在测试时的 10s 单次窗口内完成；其余 6 轮请求失败后按原始查询继续
- Action Gate：8/8 首次通过，repair=0
- Native FC：8/8 参数正确
- Tool Runtime：8/8
- Soul：8/8
- 耗时：平均 25.89s，最短 22.80s，最长 30.20s

结论：普通 API 的自定义 Native FC 正常。模型强制思考、延迟较高，不适合承担低延迟 CITA，但降级继续机制有效。当前已将 K2.7 Code、K3 的 CITA 专用预算提高到总计 40s、单次 20s。

### 3.7 Kimi for Coding（TokenPlan 专属端点）

- Base URL：`https://api.kimi.com/coding/v1`
- 请求模型 ID：`kimi-for-coding`
- 底层模型：K2.7 Code
- Profile：A 档 `provider_json_schema`
- CITA：0/10，均为模型请求阶段失败
- Action Gate：7/10 成功，证明 JSON Schema 能力存在
- Native FC：0/7，首次请求和一次 repair 后仍无唯一有效的自定义 tool call
- Tool Runtime：0 次
- Soul：10/10
- 完整 Work：0/10

结论：该端点面向 IDE 插件和官方 Coding Agent，工具体系与平台内置代码、文件工具绑定。它兼容 OpenAI 请求格式，但不适合作为 Cyrene 用户自定义 Native FC 的 Work 端点。系统保持 fail-closed，不因文本伪造或无效工具输出执行工具。

### 3.8 MiniMax M3

- Profile：专用 M 档 `prompt_json`
- 完整 Work：10/10
- CITA、Action Gate：10/10 首次通过
- Native FC：10/10
- Tool Runtime：10/10
- Soul：10/10
- 平均耗时：10.61s

结论：MiniMax M3 不采用普通 D 档，使用厂商专用 M Profile、JSON 提示、reasoning 分离和独立预算后稳定。

### 3.9 GLM 5.1

- Profile：B 档 `provider_json_object`
- 完整 Work：5/5
- CITA：4/5 首次成功；1 轮 `MODEL_REQUEST_FAILED`
- CITA 失败轮：按原始查询继续，后续 Action Gate、Native FC、Tool Runtime、Soul 全部成功
- Action Gate：5/5
- Native FC / Tool Runtime：5/5
- Soul：5/5
- 平均耗时：12.59s

结论：B 档可用，前置失败继续路由得到验证。

### 3.10 GLM 5.2

- Profile：B 档 `provider_json_object`
- 完整 Work：4/5
- CITA：5/5
- Action Gate：4/5；1 轮 `MODEL_REQUEST_FAILED`
- 失败轮：工具未执行，由 Failure Soul 回复
- Soul：5/5
- 平均耗时：11.57s

结论：未观察到 JSON 或 Schema 问题，主要风险为偶发请求失败。

### 3.11 GLM 4.7

低频 5 轮测试结果：

- 完整 Work：0/5
- Soul：4/5
- CITA：1/5 成功
- Action Gate：0/5
- Native FC / Tool Runtime：0/5
- 1 轮触发全图超时
- 平均耗时：23.23s

首批密集样本还出现过官方 HTTP 429，已从低频能力判断中排除。B 档预算加倍后追加过一个观察样本：CITA 成功，但整轮仍因后续响应过慢而超时，因此停止继续消耗额度。

结论：协议方向仍是 B 档 `json_object`，但当前响应速度不适合 Cyrene Work 默认链路。

## 4. 当前结构化输出预算

| Profile | CITA 总预算 / 单次 | Action Gate 总预算 / 单次 | 最大请求次数 |
|---|---:|---:|---:|
| A | 20s / 10s | 25s / 12.5s | 2 |
| Kimi K2.7 Code / K3 / `kimi-for-coding` | 40s / 20s | 25s / 12.5s | 2 |
| B | 16s / 8s | 20s / 10s | 2 |
| MiniMax M | 10s / 5.5s | 12s / 7s | 2 |
| D / 自定义 / 本地 | 8s / 4s | 10s / 5s | 2 |

补充规则：

- 请求成功后立即继续，不会等待预算结束。
- 网络、HTTP、内容过滤、拒绝和请求超时统一 fail-closed，不把错误内容反喂模型。
- 只有请求成功但格式或 Schema 不合格时才进入协议 repair。
- CITA 失败可以降级为原始查询继续。
- Action Gate 失败禁止工具执行，进入 Failure Soul。
- Native FC 必须收到真实且唯一有效的 tool call；否则 `toolExecuted=false`。

## 5. 最终建议

### 推荐用于 Work

- DeepSeek V4 Flash/pro
- 豆包 Seed
- Qwen
- MiMo 2.5/pro
- Kimi K2.6
- Kimi K2.7 Code 普通 API（接受较高延迟）
- MiniMax M3（必须使用专用 M Profile）
- GLM 5.1 / 5.2

### 不推荐用于 Work

- Kimi for Coding TokenPlan：自定义 Native FC 不可靠
- GLM 4.7：响应速度与当前 Work 链路不匹配
- 自定义端点和本地模型：固定 D 档，用户自行验证，不在本项目技术支持范围

### 本轮不测试

- GPT 系列
- Claude 系列

