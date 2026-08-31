# Upstream

- 仓库：https://github.com/Code-MonkeyZhang/cloud-music-mcp
- Commit SHA：63fc2409fef04f7205f4f9987f89d36aca87ac5b
- Vendored 日期：2026-07-15

## 本项目补丁

| 文件 | 改动 | 目的 |
|---|---|---|
| `auth.py` | 末尾追加 `begin_login` / `check_login` / `cancel_login` / `validate_session_three_state` + 模块级 `_PENDING_SESSIONS` 单例状态机；新增 `STORAGE_DIR` 读取 `CYRENE_MUSIC_STORAGE_DIR` 环境变量；新增 Cookie 写入 `tempfile + os.replace` 原子写；新增 `_sanitize` 日志脱敏 + `_logger = logging.getLogger("cloud_music_mcp.cyrene")`（spec-review nit：原代码引用未定义的 `logger`，会让 803 异常路径 NameError）；`check_login` 的 803 分支删除对 legacy `save_session()` 的调用，使 env-controlled runtime dir 成为 cookies 的 **single source of truth**，`credentialsPersisted` 仅在原子写实际成功时为 `True`；`check_login` 整个事务（包含网络调用）均在 `_PENDING_LOCK` 内执行，避免 cancel_login 与 in-flight 803 授权交错；`validate_session_three_state` 从 env-controlled runtime dir 直接读 `cookies.json`，`reason` 字段只输出稳定错误码（`storage_read_failed` / `api_unreachable`），不再回显原始异常文本（异常文本可能泄漏 bearer / cookie 值） | 提供非阻塞扫码会话接口、复用 pyncm 完成 weapi 加密、消除对 `os.startfile` 的依赖；消除双写 + 启动看不到 cookie 的破坏性 bug；消除 cancel/803 的竞态；消除异常文本回显的凭据泄漏风险 |
| `main.py` | 文件末尾追加三条 `@mcp.tool` 注册：`cyrene_music_login_begin` / `cyrene_music_login_check` / `cyrene_music_login_cancel`；每条工具直接调用 `auth.begin_login` / `check_login` / `cancel_login` 并通过 `_sanitize` 脱敏后写日志；新的 `from cloud_music_mcp.auth import ... _sanitize` 放在 `if __name__ == "__main__"` 之后。**Legacy `cloud_music_login` 工具与 `login_via_qrcode` 调用原样保留**，未做任何修改或删除——任何非 Cyrene 调用方不受影响 | 把 auth.py 的非阻塞会话接口暴露为 MCP 工具，让上层 Agent / Cyrene 前端可以 `begin → poll → cancel` 扫码流程，避免阻塞 MCP transport；同时为 `cloud_music_status` 等下游查询工具复用持久化的 cookies 提供入口 |
| `tests/test_auth.py` | 10 个测试用例：在原有 9 个 auth 行为用例基础上新增 `test_main_module_exposes_cyrene_login_tools`：断言 FastMCP `_tool_manager._tools` 中同时存在 `cyrene_music_login_begin` / `cyrene_music_login_check` / `cyrene_music_login_cancel` 与 legacy `cloud_music_login`（**回归保护：Cyrene 注册不能卸掉旧工具**）。全部走 `monkeypatch.setattr`，autouse fixture 将 legacy `save_session` 替换为 no-op 以防生产代码回退到 legacy 写 | 单元测试 + 工具注册回归保护 |
| `pyproject.toml` | 新增 `[tool.uv] dev-dependencies = ["pytest>=8.0"]` | 让 venv 自带 pytest，便于 vendored 项目独立跑测试 |
| `uv.lock` | 自动 lock 后含 pytest 依赖 | 与 pyproject.toml 保持一致 |
| `.gitignore` | 新增 `src/cloud_music_mcp.egg-info/` | 忽略 `uv sync` 生成的本地构建产物 |

## 测试运行

```bash
cd vendor/cloud-music-mcp
uv sync
uv run --frozen python -m pytest tests/test_auth.py -v
```

> 在 Windows 上必须用 `python -m pytest` 而不是直接 `pytest`，因为 PATH 里的 pytest 可能来自其他 venv，不会带 vendored 项目的 editable install。

## 同步上游

1. `git fetch upstream`
2. 对照本补丁表合并（注意 `.gitignore`、UPSTREAM.md、pyproject.toml 的 dev-dependencies 可能与上游冲突）
3. 重新跑 `vendor/cloud-music-mcp` 下的单元测试
4. 更新本文件 SHA 行