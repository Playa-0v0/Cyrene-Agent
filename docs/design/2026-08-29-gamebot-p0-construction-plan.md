# GameBot P0 施工计划

> **状态**: 施工稿（基于设计稿 v2）
> **日期**: 2026-08-29
> **性质**: 可执行的实施步骤与验收标准
> **依据**: `docs/design/gamebot-Honkai-Star-Rail.md`（v2）
> **范围**: 仅 P0（最小闭环，验证"模型当大脑"）。P1/P2 不在本文范围内。

---

## 0. 一句话目标

按 v2 设计稿实现 GameBot P0：**Rust helper 扩展（无头截屏 + SendInput 注入）+ screen-tools 工具组（观察帧契约）+ 会话管理（session-scoped capability + 全局急停）+ game-hsr skill v1**，跑通设计稿 §7 的四维成功标准。

---

## 1. 施工边界

### 1.1 必须新增 / 改动的范围

| 层 | 内容 |
|---|---|
| 原生层 | 新建 `native/cyrene-gamebot/`（Rust helper exe）：无头截屏（DXGI + GDI 回退）、SendInput 注入、注入前校验原语 |
| 主进程新模块 | `src/main/gamebot/`：`helper-client.ts`、`session-manager.ts`、`frame-registry.ts`、`screen-tools.ts`、`bootstrap.ts` |
| 工具接线 | `screen-tools.ts` 输出 `ToolDefinition[]`，参照 `src/main/music/bootstrap.ts` 模式挂载 |
| 权限 | `src/main/permission-policy.ts`：`input-control` 风险在活动 gamebot 会话内放行（session-scoped capability），无会话维持 ask |
| 设置 | "允许控制键鼠"总闸（默认关），挂 `src/main/settings/general-settings.ts` |
| 急停 | 主进程 `globalShortcut` 全局热键（F12），直接 kill helper 进程 |
| Skill | `skills/game-hsr/SKILL.md` v1（仅清体力流程） |

### 1.2 明确不动的范围

- **Harness 核心循环**（`2026-08-08-cyreneHarnessloopdesign.md` 冻结的架构）——GameBot 只是普通工具调用方
- **现有交互式截图子系统**（`src/main/screenshot/` + overlay）——一套已验证的面向人的链路，一行不碰
- **现有 `input-control` 语义**——只加"活动 gamebot 会话豁免"分支，不改其他档位行为
- Chat / Code 模式、music / memory / CITA
- P1 能力一律不做：OCR、`screen_find_image` / `screen_find_text`、`screen_wait_for`、`screen_template_save`、状态浮窗、提权流程、定时调度

### 1.3 设计稿到代码的映射修正（以代码为准）

| 设计稿表述 | 代码事实 | 施工采用 |
|---|---|---|
| `risk: dangerous` | 枚举实为 `"safe" \| "fs-read" \| "fs-write" \| "shell" \| "network" \| "input-control"`（`permission-policy.ts:16`） | 注入类工具 `risk: "input-control"` |
| 原生模块"动原生层" | 原生层是 **Rust helper exe**（`native/cyrene-screenshot` → `resources/bin/cyrene-screenshot.exe`，JSON 协议），非 Node addon | 新建独立 crate，复用 helper exe 模式 |
| DXGI 依赖 | `cyrene-screenshot` 的 `windows` crate 已启用 `Win32_Graphics_Dxgi`、`Win32_UI_Input_KeyboardAndMouse` | 新 crate 按需复制该依赖面 |

---

## 2. 前置准备（第 0 天）

- [ ] 基线：`npm run build` / `npm run test` 当前通过
- [ ] 基线：`cargo build` 可构建现有 helper（确认 Rust 工具链与构建脚本入口，`scripts/verify/screenshot-helper.mjs` 的打包链路作为参照）
- [ ] 分支：从 `master` 切出 `feat/gamebot-p0`
- [ ] 测试环境就绪：星穹铁道客户端、无边框窗口模式、测试账号；明确本机分辨率与 DPI 缩放记录进基线文档
- [ ] 免责声明：用户文档写明"自动化游戏操作违反多数游戏用户协议，风险自担"（放 P0 交付物 `docs/user-guide` 或 skill 内，随 Phase 6 定）

---

## 3. Phase 1：Rust helper —— 无头截屏

**目标**：`cyrene-gamebot.exe` 能按目标窗口截屏，返回 PNG + 观察帧元数据。只读，不注入。

### 3.1 新建 `native/cyrene-gamebot/`

- [ ] 独立 crate（不扩展现有 helper——`cyrene-screenshot` 的生命周期是"交互式选区"，GameBot 是常驻服务，混用互相牵制；构建/打包脚本参照现有 helper 加一条）
- [ ] 依赖面：从 `cyrene-screenshot/Cargo.toml` 复制 `windows` crate 所需 features（`Win32_Graphics_Dxgi` 系 + `Win32_UI_WindowsAndMessaging` + `Win32_System_Threading` 等）

### 3.2 截屏命令

- [ ] `capture` 命令：入参 `{ target: "hwnd" | "primary-display", hwnd?: number, crop?: [x, y, w, h] }`（归一化裁剪由主进程换算成像素后传入，helper 不懂比例）
- [ ] 实现：DXGI Desktop Duplication 优先 → 捕获显示器输出后按窗口客户区裁剪（设计稿 §8.2 措辞）；GDI `PrintWindow`/`BitBlt` 作回退后端
- [ ] 出参：`{ frameId, hwnd, pid, clientRect: [x, y, w, h], capturedAt, png }`——`frameId` 用 uuid v4，`pid` 由 HWND 反查（`GetWindowThreadProcessId`）
- [ ] `enumerate` 命令：按窗口标题模糊匹配返回候选 HWND 列表（供 session_start 定位游戏窗口）

### 3.3 主进程 client

- [ ] `src/main/gamebot/helper-client.ts`：spawn / 长驻 / JSON 协议帧 / 请求-响应关联——协议校验写法参照 `src/main/screenshot/protocol.ts`（含 `protocol.test.ts` 的守卫风格）
- [ ] helper 崩溃 / 超时的兜底：重启 helper，返回结构化错误给调用方

### 3.4 验收

- [ ] 单测：协议帧校验（合法 / 非法 / 半包）
- [ ] 手动：无边框窗口截图正确；**独占全屏实测**（DXGI 是否黑屏）→ 结论记录进 §10 基线文档；GDI 回退路径可用
- [ ] DPI 缩放 ≠ 100% 的机器上 clientRect 换算正确

### 3.5 输出

- [ ] commit：`feat(gamebot): native helper headless capture`

---

## 4. Phase 2：Rust helper —— 输入注入

**目标**：SendInput 注入 + helper 侧校验原语。**本阶段只在记事本等无害目标上验收。**

### 4.1 注入命令

- [ ] `click { hwnd, x, y }` / `key { vk, downMs? }` / `scroll { hwnd, delta }`——坐标为**客户区像素**（归一化换算在主进程做，helper 保持"收到什么打什么"的 dumb 层）
- [ ] 实现走 `SendInput`（`Win32_UI_Input_KeyboardAndMouse`），鼠标先 `SetCursorPos` 再注入点击

### 4.2 helper 侧校验原语（双保险的第一道）

- [ ] 注入前校验：`GetForegroundWindow() == 目标 hwnd`；不一致返回 `{ ok: false, code: "target_not_foreground" }`，**拒绝注入**
- [ ] 目标窗口有效性：`IsWindow(hwnd)` + 客户区尺寸抽查，失败返回 `target_changed` / `target_moved`
- [ ] 错误码与设计稿 §3.4 清单同名，主进程与 helper 两侧同语义

### 4.3 急停语义

- [ ] 选型：**主进程直接 kill helper 进程**作为急停的最终手段（最简单、必达、不依赖 helper 自身健康）；helper 内不实现热键监听
- [ ] kill 后 helper 状态自然释放（无全局钩子驻留——P0 不装低级键盘钩子，热键用主进程 `globalShortcut`，见 Phase 5）

### 4.4 验收

- [ ] 记事本：点击 / 按键 / 滚轮注入生效
- [ ] 注入瞬间手动 Alt+Tab → 注入被拒（`target_not_foreground`），按键**没有**落进切走后的前台程序
- [ ] kill helper 后无残留进程、无输入卡死

### 4.5 输出

- [ ] commit：`feat(gamebot): native helper sendinput with foreground guard`

---

## 5. Phase 3：主进程 gamebot 模块 + 观察帧契约

**目标**：设计稿 §3.4 / §4 的全部契约在 TypeScript 层落地，工具可被 Harness 调用。

### 5.1 `session-manager.ts`

- [ ] 会话状态机：`idle → active → (stopped | timeout | budget-exhausted | hotkey-killed)`
- [ ] `start`：校验设置总闸 → `enumerate` 定位游戏窗口（唯一命中才继续，多候选报错）→ 登记 `{ hwnd, pid }` → 记动作预算（默认 60 步）/ 会话超时（默认 30 分钟）
- [ ] `stop`：kill helper、状态落终态、授权撤销
- [ ] 动作计数：每个注入类工具执行成功 +1，预算耗尽自动走 `stop` 流程

### 5.2 `frame-registry.ts`

- [ ] `frameId → { hwnd, pid, clientRect, capturedAt }` 注册表（内存即可，会话结束清空）
- [ ] stale 判定：`capturedAt` 距今 > 2s 即过期（设计稿 P0 定值，验收阶段实测调整）

### 5.3 `screen-tools.ts`（`ToolDefinition[]`）

- [ ] P0 工具七件：`automation_session_start` / `automation_session_stop` / `automation_session_status` / `screen_capture` / `automation_wait` / `screen_click` / `screen_key` / `screen_scroll`
- [ ] risk 映射：注入类 = `"input-control"`；会话管理 / 截屏 / 等待 = `"safe"`（§1.3 修正）
- [ ] `modes`：仅挂 Harness 系模式（work / daily / learn），chat / code 不出现
- [ ] inputSchema：注入类必填 `frameId`（设计稿 §3.4，schema 层就拒绝裸坐标）
- [ ] **注入类 execute 前置校验链**（顺序执行，任一失败即返回对应错误码 + 重新截图提示）：
  1. 会话有效（`session_invalid`）
  2. `frameId` 在注册表且未过期（`stale_frame`）
  3. 帧 hwnd/pid == 会话登记值（`target_changed`）
  4. 窗口尺寸与帧 clientRect 一致（`target_moved`）
  5. 调 helper 注入（helper 侧再做一次前台校验，双保险）
- [ ] `screen_capture` execute：调 helper `capture` → 注册帧 → 返回图像块 + 元数据
- [ ] 工具返回值统一 JSON：成功带数据，失败带 `{ code, hint }`，`hint` 明确指路（如"请重新 screen_capture 后再试"）

### 5.4 `bootstrap.ts`

- [ ] 参照 `src/main/music/bootstrap.ts`：构建工具数组 → 注册进 tool-registry；无会话时注入类工具仍在表中（模型能看到）但 execute 直接拒绝

### 5.5 验收

- [ ] 单测：校验链五分支全覆盖（mock helper）；预算耗尽 / 超时 / 热停三分支
- [ ] 单测：无会话调用注入工具 → `session_invalid`
- [ ] 冒烟：Harness 中模型能列出并调用工具，无会话时收到结构化拒绝而非异常

### 5.6 输出

- [ ] commit：`feat(gamebot): session manager, frame registry, screen tools with frame contract`

---

## 6. Phase 4：权限与会话级授权

**目标**：设计稿 §3.2 审批语义落地——开会话批一次，会话内不重复审批。

### 6.1 `permission-policy.ts` 改动

- [ ] `input-control` 分支：活动 gamebot 会话存在 → `"allow"`（仍走审计记录）；无会话 → 维持 `"ask"`
- [ ] 会话状态查询通过注入的 session-manager 引用，policy 层不 import 具体模块（避免环）
- [ ] **确认影响面**：grep 全库现有 `input-control` 使用方（当前除 GameBot 外疑似无人使用，施工时核实），确保豁免分支不影响其他调用

### 6.2 设置总闸

- [ ] `general-settings.ts` 加 `gamebot_enable: boolean`（默认 `false`），设置 UI 出一个开关项
- [ ] 总闸关闭时：`automation_session_start` execute 直接返回结构化提示"键鼠控制未开启，请到设置开启"，不进确认链

### 6.3 首次确认链路

- [ ] `automation_session_start` 标 `input-control` 风险 → 无会话时天然走既有 ask 流程 → 批准即建会话（§3.2 语义），不新造确认 UI

### 6.4 验收

- [ ] 总闸关 → 开会话被拒；总闸开 → 首次开会话弹确认；会话内连续注入**零弹窗**；会话结束后再注入 → 重新 ask
- [ ] `permission-policy.test.ts` 补四个分支用例

### 6.5 输出

- [ ] commit：`feat(gamebot): session-scoped input-control capability`

---

## 7. Phase 5：全局急停热键

**目标**：设计稿 §6"不经过模型、不经过渲染进程"的最终断路器。

- [ ] 主进程 `globalShortcut`（Electron 内置，非钩子）注册 F12（可配置）
- [ ] 触发动作（顺序）：kill helper → session 置 `hotkey-killed` → 托盘/主窗口提示"自动化已急停"
- [ ] 无活动会话时 F12 不做任何事
- [ ] 验收：注入循环进行中按 F12，**当次**注入后立即无后续输入；helper 进程确认退出；再开会话需重新批准
- [ ] commit：`feat(gamebot): global panic hotkey`

---

## 8. Phase 6：skill v1 + 模式接通

**目标**：模型知道"怎么做清体力"，且只在正确模式可见。

### 8.1 `skills/game-hsr/SKILL.md`

- [ ] frontmatter：`name` / `description`（含触发词"清体力""刷体力"）/ `modes`（Harness 系）/ `hiddenFromUi: false`
- [ ] 流程知识（纯文字，对应 P0 工具集，无 find 类工具——流程写法必须是"截图 → 自己看图 → 坐标点击"风格）：
  - 前置：确认无边框窗口、游戏前台；开会话
  - 读体力：截图 → 看右上角数字（模型读图）
  - 选副本传送：打开生存索引 → 点对应文字/位置 → 传送 → 截图确认到位
  - 设连刷次数 → 开始挑战 → `automation_wait` 分段等待 + 截图判断"再来一次"是否出现 → 循环
  - 退出副本 → 结束会话 → 向用户汇报（做了什么 / 用了多少步 / 有无异常）
- [ ] **禁区黑名单**：充值 / 购买 / 设置 / 账号 / 客服 / 一切真实货币相关——永不点击；不确定的界面元素不点，先截图报告用户
- [ ] **护栏规则**：单次任务预算 60 步；同一目标连续 3 次找不到 → 停下汇报而非硬猜；工具返回结构化错误码时按 hint 处理（`stale_frame` → 重新截图，`target_not_foreground` → 提示用户切回游戏）
- [ ] 免责声明写进 skill 末尾

### 8.2 接通验证

- [ ] skill 扫描可见（`skill-scanner` / `skill-catalog` 现有测试模式补一条）
- [ ] 对话说"帮我清体力"能触发 skill 激活（slash-activation 或自动发现链路，施工时按现有机制接）
- [ ] commit：`feat(gamebot): hsr skill v1`

---

## 9. Phase 7：四维成功标准验收（P0 收口）

**目标**：按设计稿 §7 的四维标准逐项验收，产出基线数据。**这一阶段不改功能，只测和记录。**

### 9.1 功能

- [ ] 用户一句"帮我清体力"，完整完成一次任务（真实游戏环境）
- [ ] 截图 → 决策 → 动作 → 再截图 闭环全程无人工干预

### 9.2 安全

- [ ] 急停热键任意步骤打断（至少 3 次随机时机）
- [ ] Alt+Tab 后下一次注入被拒（观察日志 `target_not_foreground`，确认输入未落别处）
- [ ] 会话超时 / 预算耗尽自动停止（人为把预算调小触发）
- [ ] 关闭游戏后再注入 → `target_changed` 拒绝

### 9.3 正确性

- [ ] 全部注入动作在日志中可溯源到 frameId；校验链五项均有真实触发记录
- [ ] 任务完成与否由模型复看截图判断，存在至少一次"工具成功但任务未完成 → 模型纠正"的真实案例

### 9.4 性能基线（写入 `docs/design/2026-08-29-gamebot-p0-baseline.md`）

- [ ] 一次完整任务：总步数 / 模型调用次数 / 截图张数 / 总耗时 / 上下文占用曲线
- [ ] `stale_frame` 阈值 2s 的实测调整建议
- [ ] DXGI 在目标机器的黑屏结论（Phase 1 带过来的数据）
- [ ] 已知问题回写设计稿 §8（只补实测结论，不扩新设计）

### 9.5 输出

- [ ] commit：`docs(gamebot): p0 acceptance baseline`
- [ ] 合并 `feat/gamebot-p0` → `master`

---

## 10. 风险与回退

| 风险 | 应对 | 回退 |
|---|---|---|
| DXGI 在独占全屏黑屏 | GDI 回退后端 + 用户文档约束无边框窗口 | Phase 1 内决出，不影响后续阶段接口 |
| SendInput 对游戏无效（反作弊 / 独占全屏焦点） | 无边框窗口约束；实测记录 | 若彻底无效 → P0 结论为"路线不可行"，止损点清晰（原生部分全部在新 exe，删目录即回退） |
| 权限豁免影响既有 `input-control` 调用方 | Phase 4 开工前 grep 确认影响面（预期为零） | 豁免分支以 session 存在性为闸，删分支即还原 |
| 模型看图决策质量不足（点不准 / 幻觉按钮） | skill 护栏 + 预算 + 错误码闭环兜底 | 这正是 P0 要回答的问题——失败结论本身就是 P0 产出，进基线文档决定是否投 P1 |
| 帧校验过严导致频繁 `stale_frame` 空转 | 阈值可配置，验收阶段调参 | 回调阈值；P1 条件等待替代傻等 |

---

## 11. 与设计稿的追溯关系

| 施工阶段 | 设计稿章节 |
|---|---|
| Phase 1 / 2（helper） | §3.1 能力层、§8.2、§8.3 |
| Phase 3（模块 + 契约） | §3.2、§3.4、§4 |
| Phase 4（权限） | §3.2 审批语义、§6 |
| Phase 5（急停） | §6 |
| Phase 6（skill） | §5 |
| Phase 7（验收） | §7 四维成功标准、§9 GPL 边界（全程不复用 March7thAssistant 代码/资源） |
