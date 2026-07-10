# 主动开口语音包

主动开口功能使用预合成 wav 音频，不消耗 LLM token。源码运行时请把语音包放在项目根目录的 `opener-pack/` 下。

## 源码运行目录

`npm run dev` 和 `npm run start` 都读取：

```text
Cyrene-Agent/
└── opener-pack/
    ├── manifest.json
    └── morning/
        └── m01.wav
```

## 正式 exe 目录

未来打包成正式 exe 后，应用会读取：

```text
<userData>/cyrene-opener-pack/
```

Windows 默认类似：

```text
C:\Users\<你的用户名>\AppData\Roaming\live2d-cyrene\cyrene-opener-pack\
```

## 最小 manifest 示例

```json
{
  "version": 1,
  "packs": {
    "morning": {
      "todayFiredFlag": "morning",
      "cooldownMs": 36000000,
      "recentAvoidN": 2,
      "items": [
        {
          "id": "m01",
          "text": "早。今天也慢慢来吧。",
          "audio": "morning/m01.wav"
        }
      ]
    }
  }
}
```

`audio` 使用相对 `opener-pack/` 的路径。对应 wav 文件必须存在，否则主动开口会跳过这条语音。

## Git 跟踪规则

仓库只保留：

```text
opener-pack/.gitkeep
opener-pack/README.md
```

本地的 `manifest.json`、wav 文件和子目录会被 Git 忽略，不会被提交。
