# Learn 模式使用说明

Learn 模式是 Cyrene 的**学习陪伴**功能：她在聊天框里陪你讨论、记笔记、还能**自动维护你的学习进度**。一切数据都存在你本地的 **Obsidian Vault** 里，不会上传。

---

## 一、它能做什么

简单讲，Learn 模式做了三件事：

1. **陪你读材料** — 把学习资料（论文、笔记、代码片段）放进 Vault，Cyrene 可以边读边和你聊。
2. **帮你整理笔记** — Cyrene 能在 Vault 里新建、补充、修改你的笔记，按章节精确定位（不会动到不相关的部分）。
3. **自动追踪进度** — 每次聊完一轮，Cyrene 会在后台悄悄记下"今天你在学什么、掌握度变化、还剩哪些问题"，写在 Vault 的 `learn/progress.md` 里。

> 进度追踪是**完全静默**的：不会弹窗、不会打断你、失败了也不会影响正常聊天。

---

## 二、目录长什么样

Learn 模式用到一份"学习工作区"，所有 Learn 相关的数据都放在这里。Cyrene 会自动帮你建立这套结构，你也可以手动整理。

首次绑定空目录时，Cyrene 会创建下面这些文件夹和文件：

```
你的学习目录/
├── README.md                  ← 工作区总说明
│
├── materials/                 ← 放原始学习资料
│   └── README.md
│       论文、PDF、文章、代码片段、课程笔记……
│       默认只读，Cyrene 不会改这里。
│
├── notes/                     ← 你和 Cyrene 一起写的笔记
│   └── README.md
│       建议每个大主题一个文件，例如：
│       notes/Transformer/...
│       notes/English/...
│
├── exercises/                 ← 练习、测验、易错题、复习记录
│   └── README.md
│       例如 exercises/TypeScript/2026-08-04-generics.md
│
├── templates/                 ← 现成的笔记模板
│   ├── topic-template.md      ← 主题笔记模板（新建主题用这个）
│   └── review-template.md     ← 复习模板（复习日用这个）
│
└── learn/
    └── progress.md            ← 你的学习进度（Cyrene 自动维护，**别手改**）
```

### 每个文件夹是干啥的

| 路径                         | 谁会写             | 用来干嘛                                  |
| ---------------------------- | ------------------ | ----------------------------------------- |
| `materials/`                 | 你（手动）          | 放原始资料，是 Cyrene 的"教材库"          |
| `notes/`                     | 你 + Cyrene        | 主题笔记，用 Obsidian 双向链接串起来      |
| `exercises/`                 | 你 + Cyrene        | 练习题、错题本、复习日记                  |
| `templates/`                 | 你（手动）          | 通用模板，按主题复制后改一下就能用         |
| `learn/progress.md`          | Cyrene（自动）      | 各主题掌握度 + 待解决问题 + 下一步建议    |

> 提示：除了 `learn/progress.md` 是 Cyrene 自己维护的之外，其他文件夹你都可以在 Obsidian 里自由编辑或增删。

---

## 三、里面的 `progress.md` 长啥样

这是 Cyrene 帮你维护的"学习账本"。打开 Vault 里的 `learn/progress.md`，你大概会看到这样的东西（YAML 部分是给程序读的，正文是给你看的）：

```markdown
---
schemaVersion: 1
currentTopic: Transformer 架构
currentSection: Self-Attention
topics:
  Transformer 架构:
    status: learning
    mastery: 35
    unresolvedQuestions: []
    lastStudiedAt: 2026-08-06T12:34:56.000Z
updatedAt: 2026-08-06T12:34:56.000Z
---

# 学习进度

**当前主题**：Transformer 架构 > Self-Attention

## 主题掌握度

- 📖 **Transformer 架构** — 35% (学习中)

## 下一步

继续讲解 Multi-Head Attention 的计算过程。
```

### 几个关键概念

- **status**（主题状态）
  - `learning`（学习中，📖）
  - `reviewing`（复习中，🔄）— 掌握度 ≥ 50 自动进入
  - `mastered`（已掌握，✅）— 掌握度 ≥ 90 自动进入
- **mastery**：0-100 的掌握度，每次对话里 Cyrene 会根据讲解的深浅自动 ±。
- **unresolvedQuestions**：这一主题里你还没解决的小问题（直接在 notes 里继续追问就行）。
- **nextStep**：Cyrene 给你建议的"下次从哪儿接着学"。

> 💡 整个流程你**不需要任何操作**。聊完一轮就更新一次，下次再聊 Cyrene 自动接着上次的进度来。

---

## 四、怎么开始用

超简单，三步搞定：

1. **新建一个空文件夹**（比如 `D:\我的学习\` 或者随便哪儿都行）。
2. 在聊天框右上角**选 Learn 模式** → **绑定这个目录**。
3. 开始和 Cyrene 聊就好。

> 如果目录是空的，Cyrene 会问你要不要**自动建一套默认结构**（点确定就行）。

之后想写笔记就直接说，比如：

- "帮我读 `materials/某篇论文.md`，给我讲讲摘要。"
- "在 `notes/Transformer/01-简介.md` 下新建一节 **Self-Attention**，内容是你刚才那段讲解。"
- "把我刚才的回答整理成复习卡片，写到 `exercises/今天的复习.md`。"
- "打开 `notes/Transformer` 让我自己看一下。"

Cyrene 会**精准地**操作指定章节，不会乱改别的地方。

---

## 五、安全 & 隐私说明

- 你的 Vault **完全在你本机**，Cyrene 只会读写你绑定的那个目录。
- 她**写不进去** `.obsidian/` 目录（那是 Obsidian 自己的配置），也不会通过路径跳转跑到别处去。
- 所有"改文件"的操作都会带上**冲突检测**：她如果拿到的是过期版本，会拒绝写入并要求她重读 — 防止覆盖你刚刚手动改的内容。

---

## 六、常见问题

**Q：进度追踪会拖慢聊天吗？**
A：不会。Cyrene 在每轮回复**结束后**才会启动一个**异步**、独立、低优先级的小模型调用去抽取进度增量，失败了就静默丢弃。

**Q：我能不能手动改 `progress.md`？**
A：技术上可以，但**不推荐**。Cyrene 下次会根据改动自动调整；如果你想重置，最干净的方式是把文件删掉，下次她会自动重建一份空的。

**Q：可以多个 Vault 吗？**
A：可以。Learn 模式**按会话**绑定 Vault，切换会话就会换一份。

**Q：怎么停止进度追踪？**
A：换回普通聊天模式（Chat / Work / Code）即可，Learn 相关的所有工具会自动注销。
