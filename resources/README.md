# 发布资源

此目录只承载 Electron 发布包的额外资源。目录结构本身与说明文件需要提交，但二进制产物不提交。

| 路径 | 来源 | Git 状态 | 用途 |
| --- | --- | --- | --- |
| `bin/cyrene-screenshot.exe` | `npm run build:screenshot-helper` | 忽略 | 截图辅助程序；打包时复制到发布包的 `bin/`。 |
| `bin/mpv/` | `npm run prepare:mpv` | 忽略 | mpv 媒体播放器（Windows x86_64）；打包时复制到发布包的 `bin/mpv/`，供音乐后端调用。 |
| `mingit/` | `npm run prepare:mingit` | 忽略 | MinGit 回退方案；优先使用用户系统已安装的 Git。 |

MinGit 的版本、下载地址与 SHA-256 校验值由 `vendor/mingit-manifest.json` 管理；请更新清单与准备脚本，而不要手动提交 `resources/mingit/` 的文件。mpv 同理由 `vendor/mpv-manifest.json` 管理。

