# run_shell 输出截断丢尾部 / run_verification 60s 超时 / read_file 假 EOF / 长命令无后台模式 已知问题（2026-09-06 调研）

> 范围：`orchestrator/tools/builtin-tools/run-shell-tool.ts`（shell 捕获层）、
> `orchestrator/verification-runner.ts`（验证执行器）、`orchestrator/tools/builtin-tools/run-verification-tool.ts`（验证工具）、
> `orchestrator/tools/fs-tools.ts`（read_file 捕获层）、`orchestrator/harness/tool-dispatcher.ts`（模型侧头尾窗口）。
> 问题 1/2 有本机 run session 实锤证据（run-1788622787563-wve6o2，2026-09-05 23:49）；
> 问题 6 为 2026-09-06 补充发现（代码审查实锤）；
> 业界对照来自 Claude Code / Codex CLI 公开文档与 issue 梯队的公开讨论；
> 2026-09-06 外部 review 修订两轮：第一轮（captureTruncated 语义分离、timeout_ms 语义纠偏、background 四护栏、发布节奏拆分）；
> 第二轮（read_file fallback 措辞纠偏、C5 改 streaming pipe + byte counter、2MB 定为 per-stream、显式 timeout_ms 后禁用 idle、超时档位再放宽、reporter 显式 default）。

## 修复状态

| 问题 | 状态 | 修复位置 |
| --- | --- | --- |
| 1 run_shell 捕获层 16KB 之外直接丢弃，汇总行/报错永远丢失 | 待修复 | run-shell-tool.ts：per-stream 捕获上限 2MB + captureTruncated 语义分离 + 返回 JSON 字段重排（stdout 置尾） |
| 2 run_verification 硬编码 60s 超时，全量测试（实测 124s）必死 | 待修复 | verification-runner.ts：test 10min / build 5min / lint+typecheck 2min；reporter 显式 default |
| 3 verification-runner 内层截断砍尾保头，长输出的汇总行落在截断区 | 待修复 | verification-runner.ts：truncateOutput 改头尾窗口 + 截断阈值放大 |
| 4 run_shell 超时不可配（idle 2min / total 30min 硬编码），且 idle 检测误伤无输出长任务 | 待修复 | run-shell-tool.ts：新增 timeout_ms 参数（钳制 1s–30min）+ 显式 deadline 后禁用 idle |
| 5 长命令无后台执行模式，模型只能整轮阻塞等待 | 待修复（二期） | run-shell-tool.ts + 新增 shell_job 工具（status/stop + wait_ms + 流式日志 64MB 上限 + 5 态状态机） |
| 6 read_file 256KB 捕获层砍头：大文件 totalLines 在残件上统计，翻页到假 EOF 静默丢后半 | 待修复 | fs-tools.ts：10MB 内存上限 + totalLines 全量统计 + 真实行号翻页 |
| 7 dispatcher 头尾窗口过小（头 4096 + 尾 1024），尾窗装不下汇总行+失败详情 | 待修复 | tool-dispatcher.ts：threshold 30K / head 12K / tail 8K |

---

## 现象与证据链

用户在桌面端 code 模式让 Cyrene 跑全量测试（`npm test`），Cyrene 十个回合换五种跑法全部失败。
run session `run-1788622787563-wve6o2`（会话 e5e9280a-dbdf-4c31-abb1-ca2c362d9e4a）完整还原：

| 回合 | 尝试 | 结果 |
| --- | --- | --- |
| 0 | `run_shell` 直接跑 `npm test` | exitCode=0（实际全部通过），但 stdout 在 16KB 处被截断，末尾 `Test Files / Tests passed` 汇总行永久丢失 |
| 1–2 | `read_tool_result` 分页读（12000 / 33000 码点处） | 落盘的就是截断后的残件，翻到末尾也翻不到汇总行 |
| 3 | `npm test > test-result.log 2>&1 &`（cmd 后台） | cmd 的 `&` 后台语法导致 exitCode 语义混乱，无法确认测试完成 |
| 4 | `run_verification`（专用验证通道） | **60.048s 超时被杀**（`durationMs: 60048, timedOut: true, errorCode: VERIFICATION_TIMEOUT`），全量测试实测需 ~124s（singleFork + maxWorkers=1 配置下） |
| 5–9 | `--reporter=basic`（vitest v4 无此名）→ `--reporter=json --outputFile`（未产出）| 连续弯路 |
| 10 | 又回头跑重定向 | 仍在 running，用户放弃 |

关键证据（`cyrene-runs/tool-results/` meta.json）：
- run_shell 记录 bytes=39665、`truncatedForModel: true`——工具返回的"完整输出"本身已残缺
- run_verification 记录 `timedOut: true, durationMs: 60048`——超时铁证

---

## 根因分析

### 根因 1：run_shell 在捕获层丢数据（架构错位）

现有工具输出管线的正确架构（harness 层）：

```
工具 execute() 返回完整字符串 result.output
    ↓
tool-dispatcher.truncateOutput()   ← 头尾窗口（给模型看的 preview）
    ↓
toolOutputStore.put()              ← 完整 output 落盘（cyrene-runs/tool-results/）
    ↓
read_tool_result 工具               ← 模型按码点分页读取完整落盘内容
```

这个三层结构与 Claude Code 的 persisted-output 机制同构，**架构本身是对的**。
问题出在最上游：run_shell 在 `child.stdout.on("data")` 回调里对超过 `SHELL_MAX_OUTPUT = 16KB`
的 chunk 直接丢弃（`truncated = true; return`）。于是：

- 工具返回的 output 是残件 → dispatcher 的"头尾窗口"在残件上操作（尾窗是 16KB 处的尾，不是真实尾）
- 落盘的是残件 → 分页读取读的也是残件
- **数据在捕获层就没了，下游全部能力救不回来**

vitest 汇总行恰恰在输出的最末尾——被永久丢弃。这等价于 Claude Code 只保留 Bash 输出前 16KB 再问模型"测试结果如何"。

深层教训：**捕获截断（数据永久丢失）与预览截断（数据完整、只是视图裁剪）是两个完全不同的事实，此前未做语义区分**。落盘 meta 的 `truncatedForModel` 已是后者语义，但工具层 `truncated` 字段含混地承担了前者语义却无人正视。

### 根因 2：run_verification 60 秒硬编码超时

`verification-runner.ts` 的 `timeoutMs = options.defaultTimeoutMs ?? 60_000`，
工具调用时未传覆盖值。全量测试在 `pool: "forks" + singleFork + maxWorkers: 1`
（防 Windows libuv 崩溃的必要配置）下实测 ~124s，**60s 超时是必然死亡**。
且超时被杀后 stdout 里只有前 60 秒的部分进度，连"跑到哪了"都无法判断。

### 根因 3：run_verification 固定 verbose reporter + 内层砍尾截断

- test 类型固定 `--reporter=verbose`（逐用例输出，量最大），本仓 79 个测试文件的 verbose 输出远超需要
- `verification-runner.ts` 的 `truncateOutput(s, 4000)` 是 `slice(0, 4000)` **砍尾保头**——与 dispatcher 的头尾窗口方向相反，长输出的汇总行/失败详情恰在尾部，全部落入截断区
- stdout/stderr 累积超 8000 字符即触发截断——即使超时问题解决，结果视图仍是残件

### 根因 4：read_file 256KB 捕获层砍头，分页变成谎言（2026-09-06 补充发现）

文件类工具与命令类工具的截断语义不同：磁盘文件是**可寻址资源**，正确模型是游标分页
（read_file 已有 startLine/maxLines），而不是头尾窗口。但当前实现在捕获层就砍头：

- [fs-tools.ts](../../src/main/orchestrator/tools/fs-tools.ts) `READ_MAX_BYTES = 256KB`，超出取 `buf.subarray(0, 256KB)`
- `totalLines` 在截断后的残件上 split 统计 → 大文件行数被严重低报
- 模型翻页到低报的行数时拿到空内容，误判 EOF——**后半文件静默丢失，无任何报错**
- 与根因 1 同病（捕获层丢数据，下游全残），但解法不同：不套头尾窗口，而是让游标分页说真话

### 根因 5：dispatcher 头尾窗口过小（2026-09-06 决策调大）

原参数 threshold 8192 / head 4096 / tail 1024：尾窗 1024 码点连 vitest 汇总行带两个失败
用例都装不下；8K~30K 的中等输出（单文件测试、build 日志）也被迫截断。
Cyrene 上下文 800K，头 12K + 尾 8K ≈ 8-10K token，单次大输出仅占约 1%，无压力。

### 根因 6：idle 2min 卡死检测是启发式，误伤无输出长任务（2026-09-06 review 修订）

"连续 2 分钟无 stdout/stderr"≠"卡死"。rm -rf 大目录、git worktree remove、链接器、
CPU 密集脚本都可能几分钟无输出（Codex 34.6M token 事故里作者明确指出：从输出层面
"正在正常删 13 万个文件"和"彻底卡死"完全无法区分）。当前实现一律 killTree，误伤。
原决策"已对齐业界、保持原状"措辞撤回——它只是一个 heuristic，需要在调用方给出
明确时长预算时让位。

### 附带问题：返回 JSON 的字段顺序削弱头尾窗口

run_shell 返回 JSON 字段顺序为 `...exitCode, stdout, stderr, timedOut...`——stderr 在 stdout 之后。
dispatcher 的尾窗会被 stderr 尾部 + 固定字段占据，stdout 尾部（汇总行）被挤出窗口。
修复捕获层之后若不调字段顺序，preview 依然看不到汇总行。

---

## 业界对照（2026-09-06 检索）

| 能力 | Claude Code | Codex CLI | Cyrene 现状 |
| --- | --- | --- | --- |
| 截断策略 | 30K 字符后中间截断（保头+尾），`BASH_MAX_OUTPUT_LENGTH` 可调 | 内存全量聚合后截断 | ❌ 捕获层只留头 16KB，尾部丢弃 |
| 完整输出落盘 | persisted-output：超阈值落盘 + 2KB 预览 + 路径回传 | 全量内存聚合后返回 | ✅ 架构已有（tool-results），❌ 但落的是截断残件 |
| 分页读取 | Read 工具读落盘文件（行号游标） | exec 输出读取 | ✅ 已有 read_tool_result（8192 码点/次 + query 查找）；❌ read_file 的行号游标被 256KB 砍头破坏 |
| 长命令异步 | `run_in_background: true` + TaskOutput 阻塞/轮询 | `yield_time_ms` 超时停靠成 cell + wait 轮询 | ❌ 无（Codex 轮询事故警示：每次轮询都是一轮完整推理 + 上下文重发，34.6M token） |
| 超时可配 | Bash 工具可传 timeout 参数 | yield_time_ms / max_output_tokens 模型可控 | ❌ idle 2min / total 30min 全硬编码 |
| 后台输出上限 | ❌ 曾出事故：后台任务日志无限增长写出 297GB 撑满磁盘（issue #34397） | — | （二期实现时必须带日志上限） |

结论：Cyrene 的 harness 层三件套（截断/落盘/分页）已经是业界同构，**缺口全部在工具捕获层与超时配置**。

---

## 对齐方案

### 方案 1：run_shell 捕获上限提升 + 截断语义分离（治根因 1）

- `SHELL_MAX_OUTPUT`（16KB 捕获丢弃）→ `SHELL_CAPTURE_LIMIT_PER_STREAM = 2MB`：**按流独立计量**，stdout ≤2MB、stderr ≤2MB，超出的 chunk 才丢弃（防失控进程撑爆内存）
  - 为什么 per-stream 而非 combined：combined 预算下 stdout 疯狂输出 2MB 会吃光预算，stderr 末尾真正的 ERROR 没容量丢失——恰是本次要保护的东西的镜像版本
- **契约如实**：2MB/流仍是捕获截断而非"不丢数据"——正常工程输出不再因 16KB 过早截断；超限时明确标记捕获不完整。长期正确形态是 stdout/stderr 持续写 backing store（临时文件）、内存只留有限 preview，但 v1 不做（50MB 输出场景未证实存在，改动量大）
- **截断语义分离**（本次事故的核心教训）：
  - 工具 JSON 的 `truncated` 字段改为 `captureTruncated`：true = 真实数据已永久丢失
  - dispatcher 落盘 meta 的 `truncatedForModel` 保持：true = 数据完整落盘，仅模型视图被裁剪
  - 两者组合模型可精确判断"落盘内容可信度"
- 视图层不再需要工具层处理——完整 output 交给 dispatcher 头尾窗口 + toolOutputStore 落盘 + read_tool_result 分页，全部既有能力自动生效
- 返回 JSON 字段重排：`stderr` 提到 `stdout` 之前，`stdout` 成为最后一个大字段 → dispatcher 尾窗必然覆盖 stdout 尾部（汇总行）
  - **定位说明**：字段重排是结构化 JSON 序列化下的临时 projection workaround，不是稳定架构契约——它对"汇总在 stdout"的命令（vitest/npm test）最优，对"报错在 stderr"的命令（部分编译器）次优。完整数据已落盘，preview 不够用时模型走 read_tool_result。最终形态可考虑显式 `outputTail` 字段，v1 不做
- `decodeShellOutput` 的 `subarray(0, SHELL_MAX_OUTPUT)` 同步改为捕获上限
- GBK/UTF-8 双解码逻辑不变（进程结束时对完整 buffer 解码）

风险与边界：最坏情况 stdout + stderr 原始捕获约 4MB，叠加 JSON 序列化开销约 5MB——对 Electron 主进程无压力，落盘与分页读取无压力（已有 397KB 先例）；
preview 仍由 dispatcher 统一窗口生成，模型上下文消耗不变。

### 方案 2：run_verification 超时分档 + reporter + 内层截断（治根因 2/3）

- 超时分档（替代一刀切 60s）：**test = 10min、build = 5min、lint/typecheck = 2min**
  - rationale：本 issue 的初心就是"verification 层不该给正常任务过短的硬编码 deadline"。Electron 项目 build 时长随仓库增长，60s 是复现同类事故的定时炸弹；deadline 是最大生命周期而非必等时长——命令正常结束就立即返回，放宽 deadline 无负面影响
- reporter：`--reporter=verbose` → **显式 `--reporter=default`**（不依赖项目 vitest.config 的 reporters 配置——若项目自己配了 verbose，CLI 不传参会回到 verbose；显式声明才是确定性契约）
- `verification-runner.ts` 内层 `truncateOutput` 改为**头尾窗口**（头 4000 + 尾 2000 + 中间标记）
- 内层累积上限 8000 字符 → 2MB/流（对齐 run_shell 捕获上限）
- 返回 JSON 同样把 stderr 排到 stdout 之前

### 方案 3：run_shell 新增 timeout_ms + 显式 deadline 后禁用 idle（治根因 4/6）

- inputSchema 增加可选 `timeout_ms`（number），**钳制到 [1000, 1_800_000]**（1s–30min），防模型传 0 或负数
- **语义 = execution deadline（执行生命周期上限）**，不是前台耐心预算：
  - 超时 → 杀进程 → 返回超时结果（命令死亡）
  - 注意与 Codex `yield_time_ms` 完全不同：Codex 超时后进程**继续运行**转 cell 可再 wait；我们的 timeout_ms 超时即终止。"等不到就转后台"的路径由方案 4 的 run_in_background 承担，两者是互补关系而非同一语义
- **idle 处理规则（治根因 6，第二轮 review 修订）**：
  - 未传 timeout_ms：维持现状 idle 2min / total 30min
  - 传了 timeout_ms：**直接禁用 idle 检测**（`idleTimeout = undefined`），只剩 total = timeout_ms 一个约束
  - 为什么是禁用而非"idle 放宽到 timeout_ms"：数学上 idle timer 从最后一次输出起计时（起点 ≥ total 起点），时长相同则永不早于 total 到期，放宽到同值等价于失效；直接禁用语义更诚实，且避免两个 timer 同时到期的竞态
  - 调用方显式给出 execution deadline 后，"无输出=卡死"的启发式让位（rm -rf / git worktree remove / linker 类无输出长任务不再被误杀）
- 超时返回信息里带上"可通过 timeout_ms 调整 / run_in_background 转后台"的提示，帮助模型自纠

### 方案 4：后台执行 + 状态查询（治根因 5，二期实现，含四护栏）

Claude Code 模式（后台 + 轮询 + 阻塞等待）：

- `run_shell` 新增可选 `run_in_background: boolean`
  - true 时：spawn 后立即返回 `{ jobId, logFile, status: "running" }`，日志写入 `userData/shell-jobs/<jobId>.log`
  - 后台任务同样走 resolveExecutionPlan 安全决策（sandbox/direct/rejected 分流不变）
- **日志捕获实现：streaming pipe + byte counter（第二轮 review 修订，替代"stdio 直写文件"）**
  - child stdout/stderr 走 pipe，data 事件里 `bytes += chunk.length` 后**立即 writeStream.write(chunk) 写盘，不在内存聚合完整输出**（pipe ≠ 内存累积——收到即写、即丢弃引用）
  - 为什么不用 `stdio: [ignore, fd, fd]` 直写：fd 直写时数据走 kernel→file，Node 看不到任何 chunk，64MB 实时上限无从执行；流式 pipe + 计数器是同时满足"内存不聚合"和"实时字节计数"的最简实现
- 新增工具 `shell_job`（id: `shell_job`，modes 同 run_shell）：
  - `action: "status"` + `job_id` + 可选 `wait_ms` → 状态 + 输出尾部 + 输出总字节数
  - `action: "stop"` + `job_id` → killTree 终止
- **护栏 1：磁盘日志上限**。`SHELL_JOB_LOG_MAX_BYTES = 64MB`（per job，stdout+stderr 合计），计数达到即 killTree + `status: "failed", reason: "output_limit_exceeded"`。Claude Code 有公开事故：后台输出无上限，单任务写出 297GB 撑满磁盘（issue #34397）。v1 固定上限 + 明确失败，不做日志轮转
- **护栏 2：5 态状态机**。`running | exited | timed_out | stopped | failed`（+ 可选 reason 字段），区分自然退出 / 超时 / 用户停止 / spawn 失败 / 输出超限。两态状态机会把五种事实压成一团
- **护栏 3：wait_ms 阻塞等待**。`status` 可传 `wait_ms`（默认 0 立即返回，上限 60000）：最多阻塞本次工具调用这么久，进程提前退出立即返回，超时返回当前 running 状态。避免模型空转 status×N——每次工具调用在 Native FC agent loop 里都是一轮完整推理 + 上下文重发，轮询并不"天然便宜"（Codex 同款事故 34.6M token）
  - **status 必带输出尾部 + 总字节数**：模型对比两次查询的增量即可判断"真在跑 / 卡死 / 常驻就绪"（serve 类进程尾部是 listening 日志且输出不再增长 = 就绪，不是卡死；这个判别需要模型语义理解，不适合死规则）
- **护栏 4：后台不受 idle 检测约束**。后台任务只受 total 上限 / 用户 stop / app 退出控制，"无输出=卡死"启发式不适用于后台（CPU 密集任务几分钟无日志是正常的）
- 后台任务保留 30 分钟 total 上限（防泄漏；v1 从严，后续按需放宽）
- **产品语义边界**：v1 background job 定位是"有限时长的异步命令"，不是 daemon/service manager——dev server 已 ready 后 30 分钟仍会被终止（模型可以判断 ready 并告知用户，但不应承诺常驻；常驻服务管理是另一个产品命题）
- 进程注册表：main 进程内存 Map；app 退出（before-quit）时统一 killTree；日志目录启动时清理 7 天前文件
- 模型工作流：`run_in_background` 启动 → 干别的/汇报进度 → `shell_job status wait_ms=30000` 阻塞等 → exited 拿 exitCode + 输出尾部

### 方案 5：分页读取（能力层，无需改动）

方案 1 落地后，read_tool_result 读到的自动是完整输出。
既有 8192 码点/次上限 + query 查找已够用。

### 方案 6：read_file 修复（治根因 4 的文件侧，2026-09-06 补充）

文件是可寻址资源，正确解是精确游标分页，不是头尾窗口：

- `READ_MAX_BYTES` 256KB → **10MB**（内存保护上限）
- **超 10MB 的如实契约（第二轮 review 修订）**：明确返回"文件超过 10MB，read_file 暂不支持"，引导用 `search_text` **直接获取匹配行上下文**（search_text 的上下文窗口是独立的，不依赖 read_file）。不承诺"search_text 定位后按行读"——该链路当前不存在（search_text 找到第 180000 行，read_file 仍会因整文件 >10MB 拒绝）
- 未来演进方向（v1 不做）：`fs.createReadStream` 逐行流式扫描，内存只留 startLine ~ startLine+maxLines 一页，顺便统计真实 totalLines——届时解除整文件大小限制。代码文件超 10MB 本身已属异常场景
- `totalLines` 改为在全量文本上统计，翻页基于真实行数——分页不再说谎
- 实现细节：10MB 大量短行场景 `text.split(/\r?\n/)` 会产生百万级字符串对象，totalLines 改为单次扫描 `\n` 计数，不建行数组（翻页时按行读取仍用现有逻辑）
- 单次输出量仍由 maxLines≤2000 控制（约 80-100KB），超出部分自然落入 dispatcher 头尾窗口 + toolOutputStore 分页，双保险
- 二进制检测逻辑不变（前 4KB 启发）
- 附带：list_dir 的 200 项上限是砍头但会注明"仅显示前 200 项"，不构成静默谎言，暂不处理

### 方案 7：dispatcher 头尾窗口调大（治根因 5，全工具统一受益）

- `DEFAULT_TRUNCATION`：threshold 8192 → **30000**、head 4096 → **12000**、tail 1024 → **8000**
- 准确语义：**30K 截断触发阈值 + 20K 截断后预览预算**——≤30K 完整返回；>30K 给头 12K + 尾 8K 的 preview（不是机械复制 Claude Code 的 30K 预算；Cyrene 有 800K 上下文，重要的是输出行为稳定可预期）
- 尾窗 8K 装得下汇总行 + 5~10 个失败用例 diff；头窗 12K 覆盖命令回显 + 启动配置 + 前几个失败文件
- 该参数作用在 dispatcher 层，read_file / list_dir / search 等所有工具的输出自动受益，无需逐工具修改

---

## 决策记录

1. **方案 1 语义分离**：工具 JSON `truncated` → `captureTruncated`（数据永久丢失），dispatcher meta `truncatedForModel`（仅视图裁剪）保持。2MB/流是"提升捕获上限"不是"不丢数据"，文档与字段命名如实。（2026-09-06 第一轮 review 修订）
2. **per-stream 计量**：stdout ≤2MB、stderr ≤2MB 独立计量，worst case 原始捕获 4MB。防 stdout 吃光 combined 预算挤掉 stderr 的 ERROR。（2026-09-06 第二轮 review 修订）
3. **字段重排定位**：临时 projection workaround，不是稳定架构契约；对 stdout 汇总类命令最优、stderr 报错类命令次优，preview 不足时模型走 read_tool_result。`outputTail` 显式字段列为演进方向，v1 不做。（2026-09-06 第一轮 review 修订）
4. **timeout_ms 语义**：execution deadline（超时杀进程），与 Codex yield_time_ms（超时转 cell 继续跑）不是同一语义，文档原对齐表述撤回。"等不到转后台"由 run_in_background 承担，两者互补。（2026-09-06 第一轮 review 修订）
5. **idle 规则**：未传 timeout_ms 维持 idle 2min / total 30min；传了直接禁用 idle（而非放宽到同值——数学上等价于失效，直接禁用语义更诚实且避免双 timer 竞态）。后台任务不受 idle 约束。（2026-09-06 两轮 review 修订，替代原"idle 保持原状"）
6. **verification 超时分档**：test=10min / build=5min / lint+typecheck=2min。deadline 是最大生命周期非必等时长，正常结束立即返回，放宽无负面影响。（2026-09-06 第二轮 review 修订，替代"test=10min 其余 60s"）
7. **reporter 确定性**：显式 `--reporter=default`，不依赖项目 vitest.config 的 reporters 配置。（2026-09-06 第二轮 review 修订）
8. **二期四护栏**：流式 pipe + byte counter 日志（64MB/job 上限，297GB 事故教训；不用 fd 直写——Node 看不到 chunk 无法实时计数）、5 态状态机 + reason、wait_ms 阻塞等待（上限 60s）、后台豁免 idle。
9. **read_file 超限契约**：>10MB 如实告知"暂不支持"，引导 search_text 直接获取匹配上下文；不承诺不存在的 fallback 链路。流式分页列为演进方向。（2026-09-06 第二轮 review 修订）
10. **工具形态**：独立 `shell_job` 工具（status/stop 两个 action），不往 run_shell 的 command 语义里塞查询参数。
11. **C5 产品定位**：v1 是有限时长异步命令（30min 上限），不是 daemon/service manager；dev server ready 后 30min 仍终止。（2026-09-06 第二轮 review 补充）
12. **dispatcher 头尾窗口**（2026-09-06 用户拍板"改大一点"）：threshold 30000 / head 12000 / tail 8000 = 30K 触发阈值 + 20K 预览预算。全工具统一生效。
13. **发布节奏**（2026-09-06 第一轮 review 修订）：一期 C1–C4 + 快照/回归后发布实机跑（原始 bug 到 C1+C3 已治愈）；background job 是新增 process supervisor 能力，拆为二期独立排期，不与 P0 修复绑死。

## 实施顺序

### 一期（P0 修复，C1 → C4 串行，每步全量相关测试通过后单独 commit，发布前快照更新 + 全量回归）

- **C1**：run_shell per-stream 捕获上限 2MB + captureTruncated 语义分离 + JSON 字段重排（方案 1）+ dispatcher 窗口 30K/12K/8K（方案 7）
- **C2**：read_file 10MB 上限 + totalLines 真实化 + 扫描计数 + 如实超限契约（方案 6）
- **C3**：verification-runner 头尾窗口 + 阈值放大 + 超时分档 + reporter 显式 default（方案 2）
- **C4**：run_shell timeout_ms 参数 + 显式 deadline 禁用 idle（方案 3）
- **发布检查点**：工具描述快照更新 + 全量回归 + 实机跑几天验证

### 二期（新能力，独立排期）

- **C5**：run_in_background + shell_job 工具（方案 4，含流式日志/64MB 上限/状态机/wait_ms/idle 豁免四护栏）
- **C6**：二期快照更新 + 全量回归

## 验收测试要点（acceptance tests）

- C1：>16KB 的 npm test 输出，preview 尾窗可见 `Test Files / Tests` 汇总行；落盘 meta 完整包含末尾
- C1（per-stream 回归）：stdout >2MB 且 stderr 末尾含 ERROR → stdout captureTruncated=true，**stderr 的 ERROR 仍存在**
- C1（捕获上限）：>2MB/流 输出 captureTruncated=true 且不再继续累积
- C2：>256KB 文本文件 totalLines 报真实行数；翻页到真实末尾；10MB 以上明确报"暂不支持"（不引导一条不存在的链路）
- C3：全量测试（~124s）run_verification 正常完成不超时；失败用例详情可见
- C3（超长输出回归）：verification 输出 >2MB → 最终 summary 仍可见（内层头尾窗口没把真实尾部搞丢）
- C3（超时分档）：build 模拟 90s 完成 → 不被 60s 杀
- C4：timeout_ms=5000 的 sleep 10 命令 5s 被杀并返回引导信息
- C4（idle 禁用回归）：timeout_ms=300000 + 命令 150 秒无任何输出后正常结束 → 不被 idle 杀，exitCode=0
- C5（二期）：后台 sleep 300 正常 running、stop 后 stopped、wait_ms 阻塞期间进程退出立即返回、写超 64MB 日志的任务被杀且 reason=output_limit_exceeded
- C5（kill 真实性）：output_limit_exceeded 后日志文件不再增长（验证 killTree 后写入真的停了，而非只改状态字段）