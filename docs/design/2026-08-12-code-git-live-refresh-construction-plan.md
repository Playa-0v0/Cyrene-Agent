# Code Git 实时刷新施工计划

> **施工方式：** 按任务顺序执行；每项先写失败测试，再写最小实现，再运行定向验证。无需新建 Worktree（独立工作树），直接在当前分支施工。

## 1. 目标

让 Code 模式的 Git 卡片在以下变化发生后自动刷新，不要求用户点击刷新按钮或切换对话：

- Cyrene 通过 Git 工具提交、切换分支、推送或回退；
- 用户在终端、IDE 或其他 Git 客户端提交、暂存、切换分支或同步；
- 用户或外部程序在绑定工作区新增、修改、删除或重命名文件。

同时让对话消息中的本轮 Review（审阅）摘要在当前任务运行期间跟随 Git 变化更新；任务终态结算后冻结为本轮最终快照。Review 卡片高度由实际可见文件数决定：1～3 个文件显示对应的 1～3 行，超过 3 个文件默认只展示前 3 个，并提供展开/收起入口。

现有 `GitService.emitChanged(sessionId)` → `CODE_GIT_CHANGED` → `CodeGitPanel.refresh()` 链路保持不变。本轮只补齐外部文件系统变化进入该链路的入口，并收紧刷新并发。

## 2. 冻结边界

1. 使用 `chokidar@^4.0.3`（跨平台文件监听库），不自行封装 `fs.watch`。
   - 当前主进程输出为 CommonJS（通用模块格式）；`chokidar` 5 为 ESM-only（仅 ECMAScript 模块），不能直接采用最新版。
   - v4 自带 TypeScript 类型，不安装 `@types/chokidar`。
2. Watcher（监听器）只运行在 Electron 主进程，不进入 Renderer（渲染进程）、Tool（工具）或 Harness（执行循环）。
3. Renderer 只提交 `sessionId`，不得提交 `workspaceRoot` 或 Git 元数据绝对路径。
4. 同一个规范化工作区只维护一个逻辑监听实例；多个 Code 会话共享它。
5. 外部变化按工作区做 300ms Debounce（防抖），一次事件风暴只产生一次变更广播。
6. Cyrene 自己完成 Git 写操作后继续立即广播，不等待文件监听事件。
7. 最后一个订阅会话离开后关闭该工作区监听；应用退出时释放全部监听和计时器。
8. 监听失败不得影响 Git 读取和写入；刷新按钮始终作为兜底。
9. Git Worktree（Git 工作树）必须受支持，不能假设真实元数据目录永远是 `<workspaceRoot>/.git`。
10. 对话 Review 只监听生成它的当前 Run（执行过程），不得跟随之后的任务或用户操作继续变化。
11. Review 在 Run 运行期间实时更新；Run 进入 `success`、`cancelled`、`timeout` 或 `runtime_error` 后执行最后一次读取并冻结。
12. Review 默认最多显示 3 个文件；1～3 个文件时卡片按实际行数自然收缩，不预留空白行。只有文件数大于 3 时才出现“再显示 N 个文件”，展开后显示全部并可收起。

## 3. 文件结构

### 新增

- `src/main/code-git/git-workspace-watcher.ts`
  - 管理工作区共享、会话订阅、真实 Git 元数据路径、事件防抖和资源释放。
- `src/main/code-git/git-workspace-watcher.test.ts`
  - 使用假的 Chokidar 适配器和假计时器验证生命周期，不依赖真实文件监听时序。
- `src/renderer/react/features/chat/components/code-git-refresh.ts`
  - 合并前端刷新请求，保证同一时刻最多执行一次 `getStatus`，期间的新事件最多补刷一次。
- `src/renderer/react/features/chat/components/code-git-refresh.test.ts`
  - 验证刷新期间的事件合并、错误恢复和销毁行为。
- `src/renderer/react/features/chat/components/code-git-live-review.ts`
  - 把本轮工具涉及文件、运行前状态和最新 Git 状态归并为运行中的 Review 快照；终态后拒绝继续更新。
- `src/renderer/react/features/chat/components/code-git-live-review.test.ts`
  - 验证只绑定当前 Run、运行中更新、终态冻结和文件过滤。

### 修改

- `package.json`、`package-lock.json`：增加 `chokidar@^4.0.3`。
- `src/main/code-git/git-service.ts`、`git-service.test.ts`：暴露安全的会话监听生命周期，并解析真实 Git 元数据目录。
- `src/main/code-git/code-git-ipc.ts`、`code-git-ipc.test.ts`：注册 `watch/unwatch` IPC（进程间通信）。
- `src/shared/ipc-channels.ts`：增加两个频道常量。
- `src/preload/index.ts`：向安全桥暴露 `watch/unwatch`。
- `src/renderer/global.d.ts`：补齐 `window.codeGit` 类型。
- `src/renderer/react/features/chat/components/CodeGitPanel.tsx`、`CodeGitPanel.test.ts`：随组件生命周期订阅、释放并使用合并刷新器。
- `src/renderer/react/features/chat/pages/ChatPage.tsx`：把当前 Run 的 Git 变化接入 Review 快照，终态时完成最后一次捕获并冻结。
- `src/renderer/react/features/chat/components/CodeGitReviewSummary.tsx`、`CodeGitReviewSummary.css`、`CodeGitReviewSummary.test.ts`：改为内容驱动高度及最多三行的展开/收起展示。
- `src/main/index.ts`：应用退出时释放 Git 监听资源。

## 4. 接口冻结

### 4.1 Git 客户端

在 `GitClient` 增加：

```ts
getGitDir(): Promise<string>;
```

`simple-git` 实现：

```ts
getGitDir: async () => path.resolve(
  input.workspaceRoot,
  (await git.raw(["rev-parse", "--absolute-git-dir"])).trim(),
),
```

虽然命令要求绝对路径，仍用 `path.resolve` 做兼容性归一。

### 4.2 工作区监听器

```ts
export interface GitWorkspaceSubscription {
  sessionId: string;
  workspaceRoot: string;
  gitDir: string;
}

export interface GitWorkspaceWatcher {
  subscribe(input: GitWorkspaceSubscription): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface GitWorkspaceWatcherDeps {
  createWatcher(paths: string[], options: WatchOptions): WorkspaceFsWatcher;
  onWorkspaceChanged(sessionIds: readonly string[]): void;
  onError(error: unknown, workspaceRoot: string): void;
  debounceMs?: number;
}
```

内部维护：

```ts
Map<normalizedWorkspaceRoot, {
  watcher: WorkspaceFsWatcher;
  sessionIds: Set<string>;
  debounceTimer?: ReturnType<typeof setTimeout>;
}>

Map<sessionId, normalizedWorkspaceRoot>
```

`subscribe` 对同一 `sessionId + workspaceRoot` 幂等；会话换工作区时先释放旧订阅。Windows 上工作区 Map key 使用 `path.resolve(root).toLowerCase()`，其他平台保留大小写。

### 4.3 Git 服务

在 `GitService` 增加：

```ts
watchSession(sessionId: string): Promise<void>;
unwatchSession(sessionId: string): Promise<void>;
dispose(): Promise<void>;
```

`watchSession` 必须复用当前 `resolveCodeSession(sessionId)`：只有存在、模式为 `code`、已绑定工作区、Git 可用且目录为仓库的会话才建立监听。随后由 `GitClient.getGitDir()` 获取真实元数据目录。

Watcher 回调只调用现有 `emitChanged(sessionId)`，不直接运行 `git status`。

### 4.4 本轮 Review 生命周期

每个 Code Run 独立保存：

```ts
interface LiveCodeGitReviewState {
  sessionId: string;
  assistantId: string;
  before: CodeGitStatus | null | undefined;
  tools: ToolExecutionRecord[];
  snapshot?: CodeGitReviewSnapshot;
  terminal: boolean;
}
```

数据流：

```text
Code Run 开始
→ 保存 gitStatusBefore
→ 监听匹配 sessionId 的 CODE_GIT_CHANGED
→ 通过合并刷新器读取最新状态
→ 更新当前 assistantId 对应消息的 gitReview
→ Run 终态前执行最后一次读取
→ 持久化最终 gitReview
→ 标记 terminal 并解除本轮监听
```

运行中的 Review 只能写入当前 `assistantId`。切换到其他对话只隐藏展示，不销毁该 Run 的监听；切回后从会话消息和活动 Run 状态恢复展示。Run 终态后，后续用户提交、其他 Run 修改或分支切换均不得改写历史 `message.gitReview`。

本轮文件范围仍以 Cyrene 当前 Run 实际产生的变更为准，不直接展示仓库所有脏文件。实现时扩充变更来源，至少覆盖结构化 `write_file`、`apply_patch` 及能够提供明确仓库相对路径的其他文件修改工具；无法可靠证明属于本轮的外部文件变化只刷新右侧 Git 卡片，不擅自写入本轮 Review。

### 4.5 IPC 与 Preload（预加载桥）

新增频道：

```ts
CODE_GIT_WATCH: "code-git:watch",
CODE_GIT_UNWATCH: "code-git:unwatch",
```

公开 API：

```ts
window.codeGit.watch(sessionId: string): Promise<void>;
window.codeGit.unwatch(sessionId: string): Promise<void>;
```

IPC 对空 `sessionId` 直接抛出“缺少会话标识”；工作区路径只在主进程通过会话存储解析。

## 5. 监听规则

逻辑监听路径：

```ts
[
  workspaceRoot,
  path.join(gitDir, "HEAD"),
  path.join(gitDir, "index"),
  path.join(gitDir, "refs"),
]
```

Chokidar 选项：

```ts
{
  ignoreInitial: true,
  atomic: true,
  awaitWriteFinish: {
    stabilityThreshold: 250,
    pollInterval: 50,
  },
  ignored: createCodeGitIgnoredPredicate({ workspaceRoot, gitDir }),
}
```

忽略规则：

- 工作区中的 `node_modules`、`dist`、`build`、`coverage`、`.cache`、`.next`、`.turbo`；
- Git 元数据中的 `objects`、`logs`、`hooks`、临时锁文件和其他非状态目录；
- 保留 `HEAD`、`index`、`refs/**`；
- 不启用 `usePolling`，避免持续磁盘和 CPU 开销。

Watcher 的 `add`、`change`、`unlink`、`addDir`、`unlinkDir` 统一进入相同的 300ms 防抖函数。

## 6. 分任务施工

### Task 1：引入兼容依赖并解析真实 Git 元数据目录

**涉及文件**

- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`src/main/code-git/git-service.ts`
- 测试：`src/main/code-git/git-service.test.ts`

- [ ] 在 `git-service.test.ts` 给假的 `GitClient` 增加 `getGitDir`，新增测试：绑定 Code 会话调用 `watchSession` 时使用客户端返回的真实 Git 目录，而不是拼接 `<workspaceRoot>/.git`。
- [ ] 运行：

```powershell
npx vitest run src/main/code-git/git-service.test.ts
```

预期：测试因 `watchSession/getGitDir` 尚不存在而失败。

- [ ] 安装依赖：

```powershell
npm install chokidar@^4.0.3
```

- [ ] 为 `GitClient` 实现 `getGitDir()`，给 `createGitService` 注入后续 Task 2 使用的 `workspaceWatcher` 接口；尚未注入时使用空实现，避免破坏既有测试构造。
- [ ] 实现 `watchSession/unwatchSession/dispose` 的服务转发和可信会话解析。
- [ ] 重跑定向测试，预期通过。
- [ ] 提交：

```powershell
git add package.json package-lock.json src/main/code-git/git-service.ts src/main/code-git/git-service.test.ts
git commit -m "feat: resolve git workspace metadata"
```

### Task 2：实现共享 Chokidar 工作区监听器

**涉及文件**

- 新增：`src/main/code-git/git-workspace-watcher.ts`
- 新增：`src/main/code-git/git-workspace-watcher.test.ts`

- [ ] 写失败测试，覆盖以下事实：
  1. 两个会话绑定同一工作区只调用一次 `createWatcher`；
  2. 第一个会话释放时 Watcher 不关闭，最后一个释放时恰好关闭一次；
  3. 同一会话重复订阅幂等；
  4. 同一会话迁移工作区会关闭无引用的旧 Watcher；
  5. 300ms 内多个文件事件只通知一次，并包含该工作区全部 `sessionId`；
  6. `dispose()` 清理全部计时器和 Watcher；
  7. `error` 只进入 `onError`，不抛进应用主流程；
  8. Git Worktree 返回的外部 `gitDir` 被加入监听路径；
  9. 忽略谓词排除重目录但保留 `HEAD/index/refs`。
- [ ] 运行：

```powershell
npx vitest run src/main/code-git/git-workspace-watcher.test.ts
```

预期：因模块不存在而失败。

- [ ] 用 `chokidar.watch()` 实现 `createGitWorkspaceWatcher`；生产适配器与可测试的接口放在同一文件，业务层不暴露 Chokidar 类型。
- [ ] 使用 `vi.useFakeTimers()` 验证 299ms 不广播、300ms 恰好广播一次。
- [ ] 重跑 Task 2 测试并运行 Task 1 回归测试。
- [ ] 提交：

```powershell
git add src/main/code-git/git-workspace-watcher.ts src/main/code-git/git-workspace-watcher.test.ts
git commit -m "feat: watch external git workspace changes"
```

### Task 3：接入 GitService 生命周期和应用退出清理

**涉及文件**

- 修改：`src/main/code-git/git-service.ts`
- 修改：`src/main/code-git/git-service.test.ts`
- 修改：`src/main/index.ts`

- [ ] 写失败测试：
  - 非 Code、无工作区、Git 不可用、非仓库的会话不会调用 Watcher；
  - 合法会话传入 `{sessionId, workspaceRoot, gitDir}`；
  - Watcher 报告多个会话变化时，现有 `onChanged` 逐个收到 `{sessionId}`；
  - `unwatchSession` 和 `dispose` 透传且可重复调用。
- [ ] 运行 GitService 定向测试，确认红灯原因来自缺失集成。
- [ ] 在 `createGitService` 内创建或接收 `GitWorkspaceWatcher`，其 `onWorkspaceChanged` 复用现有 `emitChanged`。
- [ ] 在 `app.on("before-quit")` 中调用 `void codeGitService?.dispose()`；把服务引用提升到可退出清理的作用域，不改变工具注册顺序。
- [ ] 运行：

```powershell
npx vitest run src/main/code-git/git-service.test.ts src/main/code-git/git-workspace-watcher.test.ts
npm run build:main
```

- [ ] 提交：

```powershell
git add src/main/code-git/git-service.ts src/main/code-git/git-service.test.ts src/main/index.ts
git commit -m "feat: manage git watcher lifecycle"
```

### Task 4：增加订阅 IPC 与安全 Preload API

**涉及文件**

- 修改：`src/shared/ipc-channels.ts`
- 修改：`src/main/code-git/code-git-ipc.ts`
- 修改：`src/main/code-git/code-git-ipc.test.ts`
- 修改：`src/preload/index.ts`
- 修改：`src/renderer/global.d.ts`

- [ ] 在 `code-git-ipc.test.ts` 写失败测试：
  - `CODE_GIT_WATCH` 只把合法 `sessionId` 传给 `service.watchSession`；
  - `CODE_GIT_UNWATCH` 只把合法 `sessionId` 传给 `service.unwatchSession`；
  - 空值和纯空白值不触碰服务并抛出明确错误；
  - Renderer 无法提交工作区路径。
- [ ] 运行 IPC 定向测试并确认失败。
- [ ] 注册两个频道；扩展 `RegisterCodeGitIpcDeps.service` Pick 类型。
- [ ] 在 Preload 增加：

```ts
watch: (sessionId: string) => ipcRenderer.invoke(IPC.CODE_GIT_WATCH, sessionId),
unwatch: (sessionId: string) => ipcRenderer.invoke(IPC.CODE_GIT_UNWATCH, sessionId),
```

- [ ] 在全局 Window 类型中声明相同签名。
- [ ] 运行：

```powershell
npx vitest run src/main/code-git/code-git-ipc.test.ts
npm run build:main
npm run build:preload
```

- [ ] 提交：

```powershell
git add src/shared/ipc-channels.ts src/main/code-git/code-git-ipc.ts src/main/code-git/code-git-ipc.test.ts src/preload/index.ts src/renderer/global.d.ts
git commit -m "feat: expose git workspace subscriptions"
```

### Task 5：让 CodeGitPanel 订阅并合并刷新

**涉及文件**

- 新增：`src/renderer/react/features/chat/components/code-git-refresh.ts`
- 新增：`src/renderer/react/features/chat/components/code-git-refresh.test.ts`
- 修改：`src/renderer/react/features/chat/components/CodeGitPanel.tsx`
- 修改：`src/renderer/react/features/chat/components/CodeGitPanel.test.ts`

- [ ] 为 `createCodeGitRefreshController` 写失败测试：
  - 空闲时请求立即执行一次加载；
  - 加载未完成时连续请求 N 次，完成后只补刷一次；
  - 加载失败后后续请求仍可运行；
  - `dispose` 后未开始的补刷被取消，异步结果不再更新状态。
- [ ] 运行刷新器测试，确认因模块不存在失败。
- [ ] 实现接口：

```ts
export interface CodeGitRefreshController {
  request(): void;
  dispose(): void;
}

export function createCodeGitRefreshController<T>(input: {
  load(): Promise<T>;
  apply(value: T): void;
  failed(): void;
  busy(value: boolean): void;
}): CodeGitRefreshController;
```

- [ ] 修改 `CodeGitPanel`：挂载时创建 Controller、调用 `api.watch(sessionId)` 并请求首次状态；收到匹配的 `CODE_GIT_CHANGED` 时调用 `request()`；清理时先 `dispose()`，再调用 `api.unwatch(sessionId)`。
- [ ] `watch` 失败只写开发日志或静默降级，不遮挡 Git 状态和刷新按钮。
- [ ] 更新组件测试中的假的 `codeGit` API，验证切换 `sessionId` 后旧订阅释放、新订阅建立；验证其他会话事件不触发刷新。
- [ ] 运行：

```powershell
npx vitest run src/renderer/react/features/chat/components/code-git-refresh.test.ts src/renderer/react/features/chat/components/CodeGitPanel.test.ts
npm run build:renderer
```

- [ ] 提交：

```powershell
git add src/renderer/react/features/chat/components/code-git-refresh.ts src/renderer/react/features/chat/components/code-git-refresh.test.ts src/renderer/react/features/chat/components/CodeGitPanel.tsx src/renderer/react/features/chat/components/CodeGitPanel.test.ts
git commit -m "feat: refresh code git status live"
```

### Task 6：绑定当前 Run 的实时 Review 并在终态冻结

**涉及文件**

- 新增：`src/renderer/react/features/chat/components/code-git-live-review.ts`
- 新增：`src/renderer/react/features/chat/components/code-git-live-review.test.ts`
- 修改：`src/renderer/react/features/chat/components/code-git-review.ts`
- 修改：`src/renderer/react/features/chat/components/code-git-review.test.ts`
- 修改：`src/renderer/react/features/chat/pages/ChatPage.tsx`

- [ ] 写失败测试，覆盖：
  1. 只有与当前 Run `sessionId + assistantId` 关联的状态变化可以更新该消息；
  2. 运行中连续变化会更新总计及每个本轮文件的 `insertions/deletions`；
  3. 其他会话事件和无法证明由本轮产生的仓库脏文件不会进入 Review；
  4. Run 终态时最后读取一次状态并冻结；
  5. `success/cancelled/timeout/runtime_error` 四种终态之后均拒绝后续更新；
  6. 切换对话不会误把其他对话事件写入当前 Review，切回后已保存快照仍可见；
  7. 写入、删除、重命名文件时路径匹配使用统一的仓库相对路径。
- [ ] 运行：

```powershell
npx vitest run src/renderer/react/features/chat/components/code-git-live-review.test.ts src/renderer/react/features/chat/components/code-git-review.test.ts
```

预期：因实时 Review 控制器尚不存在而失败。

- [ ] 实现本轮 Review 控制器，复用 Task 5 的刷新合并原则，不为每个 Git 文件事件并发执行 `getStatus`。
- [ ] 在 `ChatPage` 的 Code Run 创建处绑定 `sessionId + assistantId`；收到匹配事件时仅更新该 assistant 消息的 `gitReview`。
- [ ] 将现有 `captureGitReview()` 收紧为终态最后读取与冻结入口，确保 `checkpointRun("terminal", true)` 保存最终快照后再解除监听。
- [ ] 保留“本轮实际修改文件”过滤，扩充可以提供明确路径的文件修改工具；不要把仓库原有脏文件并入本轮摘要。
- [ ] 运行定向测试和 Renderer 构建：

```powershell
npx vitest run src/renderer/react/features/chat/components/code-git-live-review.test.ts src/renderer/react/features/chat/components/code-git-review.test.ts
npm run build:renderer
```

- [ ] 提交：

```powershell
git add src/renderer/react/features/chat/components/code-git-live-review.ts src/renderer/react/features/chat/components/code-git-live-review.test.ts src/renderer/react/features/chat/components/code-git-review.ts src/renderer/react/features/chat/components/code-git-review.test.ts src/renderer/react/features/chat/pages/ChatPage.tsx
git commit -m "feat: update run review snapshots live"
```

### Task 7：让 Review 卡片按文件数自适应高度

**涉及文件**

- 修改：`src/renderer/react/features/chat/components/CodeGitReviewSummary.tsx`
- 修改：`src/renderer/react/features/chat/components/CodeGitReviewSummary.css`
- 修改：`src/renderer/react/features/chat/components/CodeGitReviewSummary.test.ts`

- [ ] 把组件测试改为可交互渲染测试，先写失败断言：
  - 1、2、3 个文件分别渲染 1、2、3 行；
  - 1～3 个文件均不渲染展开按钮；
  - 10 个文件默认只渲染前 3 行，并显示“再显示 7 个文件”；
  - 点击后渲染全部 10 行并显示“收起”；
  - 再次点击恢复 3 行；
  - 标题和汇总 `+x/-y` 始终使用全部 10 个文件的数据，而不是前三个的局部合计。
- [ ] 运行：

```powershell
npx vitest run src/renderer/react/features/chat/components/CodeGitReviewSummary.test.ts
```

预期：交互和自适应高度断言至少一项失败。

- [ ] 保留 `snapshot.files.slice(0, 3)` 默认逻辑和现有 `expanded` 状态；为文件行增加稳定的测试标识，展开按钮仅在 `snapshot.files.length > 3` 时存在。
- [ ] 从 `CodeGitReviewSummary.css` 删除 `.cy-git-review-summary` 的 `min-height: 168px`，不得用新的固定高度替代。卡片高度只由标题、实际可见文件行和可选展开按钮自然撑开。
- [ ] 保留最多 3 行的默认展示，不在折叠态增加空占位、滚动区或固定最小高度。
- [ ] 运行测试与 Renderer 构建：

```powershell
npx vitest run src/renderer/react/features/chat/components/CodeGitReviewSummary.test.ts
npm run build:renderer
```

- [ ] 提交：

```powershell
git add src/renderer/react/features/chat/components/CodeGitReviewSummary.tsx src/renderer/react/features/chat/components/CodeGitReviewSummary.css src/renderer/react/features/chat/components/CodeGitReviewSummary.test.ts
git commit -m "fix: size code review summary to its files"
```

### Task 8：回归与人工验收

- [ ] 运行全部 Code Git 定向测试：

```powershell
npx vitest run src/main/code-git/git-executable.test.ts src/main/code-git/git-service.test.ts src/main/code-git/git-workspace-watcher.test.ts src/main/code-git/code-git-ipc.test.ts src/renderer/react/features/chat/components/code-git-refresh.test.ts src/renderer/react/features/chat/components/CodeGitPanel.test.ts src/renderer/react/features/chat/components/code-git-review.test.ts src/renderer/react/features/chat/components/code-git-live-review.test.ts src/renderer/react/features/chat/components/CodeGitReviewSummary.test.ts
```

- [ ] 运行三端构建：

```powershell
npm run build:main
npm run build:preload
npm run build:renderer
```

- [ ] 运行全量测试并如实记录既有 Baseline（基线）失败，不把无关失败混入本任务：

```powershell
npx vitest run
```

- [ ] 启动应用，在同一绑定仓库依次人工验证：
  1. 终端修改文件，卡片约 1 秒内更新增删行；
  2. 终端执行 `git add`，状态自动刷新；
  3. 终端执行 `git commit`，变更清零且 ahead 更新；
  4. 终端切换分支，卡片分支名自动变化；
  5. Cyrene 调用 `git_commit`，仍在工具完成后立即更新；
  6. 两个 Code 对话绑定同一仓库，二者切回后状态一致；
  7. 离开 Code 对话后修改仓库，不出现泄漏、报错或持续刷新；切回后首次状态正确；
  8. Git Worktree 场景的提交和切分支也会更新；
  9. 模拟监听失败后，手动刷新按钮仍可用；
  10. 当前 Run 只修改 1、2、3 个文件时，Review 卡片分别只有 1、2、3 行且没有底部空白；
  11. 当前 Run 修改 10 个文件时默认只展示前 3 个，“再显示 7 个文件”可展开全部并可再次收起；
  12. 当前 Run 执行期间继续修改同一文件，Review 的文件行及 `+x/-y` 会更新；
  13. 当前 Run 结束后在终端继续修改或提交，历史 Review 保持冻结；
  14. 运行途中切换对话再切回，当前 Run 的 Review 仍存在并继续更新，且不会串到其他会话。
- [ ] 检查 Electron 退出后无残留进程。
- [ ] 若只产生测试或兼容性收尾改动，将其与对应实现一起提交；不要创建无意义空提交。

## 7. 验收标准

- 用户通过终端、IDE 或其他 Git 客户端产生的工作区/Git 状态变化，会在正常机器上约 1 秒内反映到 Code Git 卡片。
- Cyrene 自己执行 Git 写操作仍即时更新，不因 Chokidar 事件重复导致明显闪烁或大量并发 `git status`。
- 同一工作区无论绑定多少 Code 会话，底层只存在一个共享逻辑监听实例。
- 会话解绑、组件卸载和应用退出均能可靠释放监听。
- Renderer 无法指定或越权监听任意绝对路径。
- Git Worktree 能解析并监听真实 Git 元数据目录。
- 对话 Review 只绑定当前 Run：运行中实时、终态最后刷新并冻结，后续操作不改写历史消息。
- Review 修改 1～3 个文件时只占对应行数且无固定高度空白；超过 3 个时默认显示前 3 个，展开/收起行为和剩余数量正确。
- 监听异常只降低为手动刷新，不影响 Cyrene Harness、Git 工具或聊天流程。
- Code Git 定向测试和 `build:main`、`build:preload`、`build:renderer` 全部通过。

## 8. 明确不做

- 不实现固定间隔 `git status` 轮询；
- 不在 Work、Learn、Chat 模式建立 Git 监听；
- 不监听仓库历史对象或解析 `.git/objects`；
- 不因为外部变化自动提交、暂存、切分支或推送；
- 不修改本轮尚未施工的 Git 分支切换/提交弹层 UI；
- 不让历史 Review 永久追踪仓库当前状态；
- 不把无法可靠归因于当前 Run 的外部文件变化写成本轮成果；
- 不让 Watcher 参与 Agent 是否继续或是否结束的判断。
