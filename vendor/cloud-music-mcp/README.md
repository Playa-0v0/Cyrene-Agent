<p align="center">
  <img src="logo.png" width="128" alt="Cloud Music MCP Logo">
</p>

# 网易云音乐 MCP 服务器

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) ![Pull Requests Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen)

> 基于 [网易云音乐开发平台](https://developer.music.163.com/st/developer/) 标准 API 实现

**🎵 为您的 AI Agent 插上音乐的翅膀**

这是一个基于 **网易云音乐 官方API** 的本地MCP服务器。可以让用户通过 Claude Code, OpenCode 等 AI Agent以**原生 API** 的方式点歌!

## 📢 Update

- **2026-06-29** 🎉 新增歌单管理 — AI 现在可以帮你创建歌单并批量添加歌曲，一句话完成「搜歌 → 建单 → 加歌」全流程。
- **2026-06-29** 🔎 新增资料查询 — 支持查询歌单详情、专辑信息、歌手信息以及你的收藏列表。
- **2026-06-16** 🔧 修复安装问题 — 替换已失效的 PyPI pyncm 为自维护 fork，补齐 build-system，并清除误提交的登录态等敏感文件。

## ✨ 功能特性

- **🤖 让 AI Agent 为你播放音乐**：通过自然语言指令控制音乐播放。只需说“给我放首热血的歌”，Agent 就会为你搞定一切。
- **🔓 扫码登录**：支持使用手机 App 扫码安全登录。登录状态（Cookies）仅保存在本地，保护您的隐私。
- **🧠 个性化推荐**：完美接入您的**每日推荐**和**歌单**。Agent 会根据您的听歌品味来播放音乐。
- **🔍 搜歌功能**：支持按关键词搜索歌曲、歌手或专辑，并直接播放。
- **📝 歌单管理**：不只是放歌，还能帮你创建歌单、批量加歌。说一句"建个某个主题的歌单"，AI 就会自动搜歌、建单、加歌一气呵成。
- **🎛️ 桌面端联动**：通过 URL Scheme 唤起网易云音乐客户端播放，无缝衔接原生体验。

## 🛠️ 工具列表

本服务器向 AI Agent 暴露以下工具：

| 工具名称 (Tool Name)              | 参数 (Parameters)                                 | 功能描述 (Description)                     |
| :-------------------------------- | :------------------------------------------------ | :----------------------------------------- |
| `cloud_music_login`               | 无                                                | 启动扫码登录流程 (模拟官方 App)。          |
| `cloud_music_status`              | 无                                                | 检查当前登录状态和用户信息。               |
| `cloud_music_get_daily_recommend` | 无                                                | 获取今日推荐歌曲列表。                     |
| `cloud_music_my_playlists`        | 无                                                | 获取用户的所有歌单（包括创建的和收藏的）。 |
| `cloud_music_playlist_detail`     | `playlist_id`: 歌单 ID                            | 获取歌单详情及歌单内所有歌曲。             |
| `cloud_music_create_playlist`     | `name`: 歌单名称 `<br>privacy`: 是否隐私(默认否)  | 创建新歌单。                               |
| `cloud_music_add_to_playlist`     | `playlist_id`: 歌单 ID `<br>track_ids`: 歌曲 ID 列表 | 批量添加歌曲到指定歌单。                |
| `cloud_music_search`              | `keyword`: 关键词 `<br>category`: 类型(默认'song') | 按关键词搜索歌曲、专辑、歌手或歌单。       |
| `cloud_music_album_info`          | `album_id`: 专辑 ID                               | 获取专辑详情及歌曲列表。                   |
| `cloud_music_artist_info`         | `artist_id`: 歌手 ID                              | 获取歌手详情和热门歌曲 Top 10。            |
| `cloud_music_my_subscriptions`    | `category`: 'artists'/'albums'                    | 获取收藏的歌手或专辑列表。                 |
| `cloud_music_play`                | `id`: 资源ID `<br>type`: 类型 ('song'/'playlist') | 播放指定的歌曲或歌单（自动唤起桌面应用）。 |

## 🚀 安装与使用

### 前置条件

- **操作系统**：macOS 或 Windows
- **Python 版本**：3.10 或更高
  - macOS：通常自带，运行 `python3 --version` 检查
  - Windows：从 [python.org](https://www.python.org/downloads/) 下载安装
- **安装网易云音乐桌面客户端**（
- **LLM 客户端**（如 Claude Desktop、OpenCode 等）

### 安装步骤

#### 1. 安装 uv 包管理器

```bash
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

#### 2. 克隆项目并安装依赖

```bash
# 克隆项目
git clone https://github.com/Code-MonkeyZhang/cloud-music-mcp.git
cd cloud-music-mcp

# 创建虚拟环境
uv venv

# 激活虚拟环境
source .venv/bin/activate  # macOS/Linux
# .venv\Scripts\activate   # Windows

# 安装项目（可编辑模式）
uv pip install -e .
```

### 配置 LLM 客户端

#### Claude Desktop

找到配置文件：

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

添加以下配置：

```json
{
  "mcpServers": {
    "cloud-music": {
      "command": ["/绝对路径到/cloud-music-mcp/.venv/bin/cloud-music-mcp"],
      "enabled": true
    }
  }
}
```

> **重要**：将 `/绝对路径/到/cloud-music-mcp` 替换为项目的实际绝对路径。Windows 用户请使用双反斜杠 `\\` 或正斜杠 `/`。

#### 开启日志（可选）

如需调试，可在配置中添加环境变量：

```json
{
  "mcpServers": {
    "cloud-music": {
      "command": ["/绝对路径/到/cloud-music-mcp/.venv/bin/cloud-music-mcp"],
      "enabled": true,
      "env": {
        "MCP_LOG_ENABLE": "true"
      }
    }
  }
}
```

**日志说明：**

- **默认状态**：日志功能默认关闭
- **开启后**：日志会以 `session_YYYYMMDD_HHMMSS.log` 的格式保存在项目根目录的 `logs/` 文件夹中

### 使用方法

1. **重启 LLM 客户端**（如 Claude Desktop）
2. **登录网易云音乐**
   - 在对话中输入："帮我扫码登录网易云音乐"
   - AI 会调用 `cloud_music_login` 工具，弹出二维码
   - 用手机网易云 App 扫码登录
   - 登录状态（Cookies）仅保存在本地，保护隐私

3. **开始使用**
   - 播放音乐："给我放首歌"
   - 获取推荐："看看今日推荐有什么"
   - 搜索歌曲："搜一下周杰伦的歌"
   - 创建歌单："帮我建个周杰伦热门歌曲的歌单"
   - 播放歌单："播放我的收藏歌单"
