---
name: obsidian-log
description: 把本仓库（cortex-work / ../server）的功能更新总结写入 Obsidian，按日期归档到「个人/cortex-work」目录。当用户要求记录项目更新、写更新总结、归档到 obsidian、写开发日志时使用。触发词:记录项目更新、写入 obsidian、归档总结、开发日志、obsidian log、/obsidian-log。
---

# 项目更新 → Obsidian 归档

把一段开发工作（本次会话完成的功能、或指定 commit 区间）总结成一篇 Markdown，写入
Obsidian vault 的 `个人/cortex-work/` 目录，**按日期归档**。

## 落盘位置（硬约定）

- Vault 目录：`/Users/mike/docs/markDown/个人/cortex-work/`
- 文件名：`YYYY-MM-DD <主题>.md`（日期用今天，主题 3~10 个字概括本次更新，如
  `2026-08-22 团队工作区·服务器工作区实现总结.md`）。
- **同一天已有同主题文件 → 编辑追加/更新该文件**（新增「## 更新 (HH:MM)」小节或修订原文），
  不要建重复文件；不同主题可同日多文件。
- 写完用户可见地确认完整路径。

## 文档格式（对齐目录内既有笔记）

1. **frontmatter**（必须）：

```yaml
---
date: YYYY-MM-DD
project: cortex-work
tags: [<功能域标签 2~4 个>]
branches: [<涉及分支，含 server 仓库时写 repo/branch 形式>]
---
```

2. **正文结构**（按需取舍，宁缺毋滥）：
   - 开头一句话总结（`>` 引用块）：这次更新做了什么、给谁用。
   - `## 架构`：**架构/流程图一律用 mermaid**（Obsidian 原生渲染），不用 ASCII 图。
   - `## 功能清单`：按前端/后端（或按模块）分列，写用户可感知的能力，不逐条罗列 commit。
   - `## 验证`：测试/冒烟结论（几例、绿否），未验证项明确列出。
   - `## 遗留项`：已知限制与后续计划。
   - 联调环境/部署信息若有变化才写；密钥类只写存放路径不写明文。

## 内容来源（写之前先取材，不凭记忆编）

- 本次会话上下文里已完成的工作优先。
- 需要补齐区间时用 `git log --oneline <上次归档日期或 tag>..HEAD` 取 cortex-work 与
  `../server`（如涉及）两仓的提交，归纳成用户视角的说明。
- 上一篇归档：`ls /Users/mike/docs/markDown/个人/cortex-work/` 按文件名日期找最近一篇，
  避免重复记录已归档内容（只写增量）。

## 风格

- 中文；技术术语/路径/命令保持原文。
- 面向「三个月后的自己」：写为什么与结论，不复述过程流水账。
- 写完把文件发给用户预览（SendUserFile，render）。
