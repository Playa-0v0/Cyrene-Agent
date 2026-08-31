# QQ / NapCat（OneBot 11）接入教程

从零开始，把 Cyrene 接入 QQ。全程大约 15 分钟。

---

## 这个方案是怎么工作的

打个比方：QQ 就像一个不对外开放的私家花园，没有正门（官方 API）。**NapCat** 是一个"扮演 QQ 客户端"的程序——它登录一个真实的 QQ 号，把 QQ 的收发消息翻译成通用协议（**OneBot 11**），Cyrene 听懂这个协议，就能借这个 QQ 号收发消息了。

```
QQ 好友/群 ── QQ 服务器 ── NapCat（登录你的机器人QQ号） ── OneBot 11 协议 ── Cyrene
```

连接方向是"反向 WebSocket"：**Cyrene 在本机开一个端口监听，NapCat 主动连过来**。所以你不需要公网 IP、不需要端口映射，两台程序在同一台电脑（或同一局域网）就能用。

> 想要官方协议、零封号风险的"机器人"身份？看 [官方 QQ Bot 接入指南](./qqbot-official.md)。两条路线二选一即可，也可以并存。

---

## 第 0 步：准备工作

- **一台 Windows 电脑**（Cyrene 所在的机器）
- **一个专门的 QQ 号**当机器人。强烈建议新注册一个，不要用自己常用号——第三方协议存在被腾讯风控/冻结的风险，虽然 NapCat 基于官方 NTQQ 实现、风险已是同类方案里最低的，但小心驶得万年船
- 机器人 QQ 号和你的常用号**互加好友**（私聊需要），或把机器人拉进一个群（群聊需要）

---

## 第 1 步：安装 NapCat

### 方式 A：NapCat.Shell（推荐，需要装 QQ）

1. 前往 [NapCatQQ 的 Releases 页面](https://github.com/NapNeko/NapCatQQ/releases)，下载最新的 `NapCat.Shell.zip` 并解压（比如解压到 `D:\NapCat`）
2. 确保 **QQ（NT 版）已安装**且为最新版本（没装就去 [im.qq.com](https://im.qq.com/) 装一个）
3. 双击解压目录里的 `launcher.bat` 启动（Windows 10 用 `launcher-win10.bat`）

### 方式 B：一键版（免装 QQ）

下载 `NapCat.Shell.Windows.OneKey.zip` 解压，运行 `NapCatInstaller.exe` 等自动化配置完成，进入生成的 `NapCat.XXXX.Shell` 目录启动 `napcat.bat`。包体较大，但完全独立。

### 方式 C：NapCatQQ-Desktop（图形界面管理）

[单文件 EXE](https://github.com/NapNeko/NapCatQQ-Desktop)，带图形界面、多账号管理、托盘后台运行，不习惯命令行窗口的话选这个。

> 版本要求：NapCat `4.8.115+`。旧版本仍可收发文本，但 Cyrene 的大文件流式传输不可用。

---

## 第 2 步：登录 QQ（扫码）

1. 启动 NapCat 后，控制台会打印一行带 token 的网址，长这样：
   ```
   [WebUI] WebUI Local Panel Url: http://127.0.0.1:6099/webui?token=xxxxx
   ```
   直接把这个完整链接复制到浏览器打开（token 就是登录密码）
   - 找不到这行？打开 NapCat 目录下的 `config/webui.json`，里面有 `token` 和 `port`（默认 6099，被占用会自动 +1）
2. 首次进入 WebUI 会要求改密码，改一个自己记得住的
3. 点「QQ 登录」→ 选「QRCode 扫码」→ 用**机器人 QQ 号**的手机 QQ 扫码
4. 登录成功后控制台会显示机器人 QQ 号和昵称

> 提示：登录状态 NapCat 会记住，之后启动不用重复扫码。如果提示登录失效，多半是频繁换 IP/设备触发风控，重新扫码即可。

---

## 第 3 步：在 Cyrene 里开监听

1. 右下角系统托盘 → Cyrene → 「设置」→「连接手机」→「**QQ（NapCat / OneBot 11）**」
2. 打开渠道开关，选择监听模式：
   - **NapCat 与 Cyrene 在同一台 Windows**（本教程默认场景）：选「仅本机 127.0.0.1」，Token 可以留空
   - **NapCat 在 WSL/Docker 里**：选「自动」或「Windows WSL 虚拟网卡」，此时**必须配置 Token**（保存时自动生成，先复制到 NapCat 再回来保存）
3. 端口保持默认 `6200`
4. 填白名单：
   - **私聊 QQ 白名单**：填你自己的常用 QQ 号（只有白名单里的人私聊才会触发 Cyrene）
   - **群号白名单**：填你拉机器人进去的群号
5. 点「保存并启动监听」，页面会显示一个**连接 URL**，形如：
   ```
   ws://127.0.0.1:6200/onebot/v11/ws
   ```
   复制它，下一步要用

> WSL 的虚拟网卡地址可能在重启后变化。连接断了别改 NapCat，以 Cyrene 设置页**实时显示的 URL** 为准更新。

---

## 第 4 步：把 NapCat 连到 Cyrene

回到 NapCat WebUI → 左侧「网络配置」→「新建」→ 选 **WebSocket 客户端**（注意是客户端，不是服务端！），按下表填写：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| Enable / 保存时启用 | 开启 | |
| URL | `ws://127.0.0.1:6200/onebot/v11/ws` | 第 3 步复制的 URL，路径必须含 `/onebot/v11/ws` |
| Message Post Format | `array` | 必须是 array |
| Report Self Message | 关闭 | |
| Reconnect Interval | `5000` | 断线自动重连 |
| Heart Interval | `30000` | |
| Token | 与 Cyrene 一致 | 仅本机 127.0.0.1 监听且 Cyrene 留空时，这里也留空 |

保存并启用。如果 NapCat 里已有给 AstrBot 等其他框架用的连接，**新建一个就行，别动原来的**，互不影响。

回到 Cyrene 设置页，状态应从「等待 NapCat 连接」变为「**NapCat 已连接**」。点「测试连接」可以看到 QQ 号、昵称、NapCat 版本等详情。

---

## 第 5 步：试一试

用你常用的 QQ 号给机器人发一条私聊（或群里 @ 它）：

- 私聊：直接发消息，Cyrene 按私聊会话回复
- 群聊：必须 `@机器人` 才触发；回复会引用你的消息并 @ 你

看到 Cyrene 回复，接入完成。

---

## 消息与权限规则

- 私聊只有 `allowedPrivateUserIds` 中的 QQ 号会触发 Cyrene。
- 群聊只有白名单群中的 `@机器人` 消息会触发；回复固定引用原消息并 @ 发送者。
- 同一群共享会话历史和 Cyrene 的个人长期记忆。只应添加可信群，避免私密记忆出现在不可信场景。
- QQ 群聊强制使用 Chat 流程，不调用工具；QQ 私聊沿用「连接手机」页面的全局工具权限设置。

## 多媒体与缓存

- 小于等于 8 MiB 的出站图片和语音使用 `base64://`。
- 更大的图片/语音以及文件、视频使用 NapCat Stream API，默认 64 KiB 分片。
- 单文件上限为 100 MiB。
- 下载缓存位于 `<userData>/channels/cache/qq/`，文件保留 24 小时，总量上限 512 MiB。
- NapCat 低于 `4.8.115` 或 Stream API 不可用时，设置页会显示兼容性警告。

---

## 排障速查

| 症状 | 原因与解法 |
| --- | --- |
| 一直「等待 NapCat 连接」 | NapCat 建的是 **WebSocket 客户端**不是服务端；URL 路径必须包含 `/onebot/v11/ws`；确认 NapCat 已登录且该连接已启用 |
| 401 Unauthorized | 两侧 Token 不一致。Cyrene 侧 Token 不回显，重新生成后同步更新 NapCat |
| WSL 里连不上 | 重新保存 Cyrene 配置，用页面显示的**新 URL**；检查 Windows 防火墙是否放行 WSL 虚拟网卡到端口 6200 |
| 群聊不回复 | 群号在白名单里吗？消息真的 @ 了机器人吗？ |
| 机器人突然掉线 | 看 NapCat 控制台是否提示登录失效，重新扫码；频繁失效说明风控了，让账号"养"几天 |
| 媒体处理失败 | NapCat 版本 ≥ 4.8.115？文件超过 100 MiB？ |
| WebUI 打不开 | 端口被占用会自动 +1，看启动日志里的实际端口；或读 `config/webui.json` |

更多细节见 [NapCat 官方文档](https://napneko.github.io/)。
