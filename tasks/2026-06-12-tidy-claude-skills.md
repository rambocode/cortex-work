# 整理 Claude Code skills，去重

范围：仅动用户可控的个人 skills（`~/.claude/skills/`）与插件开关，不碰 CLI 内置 skills。

## 背景

skill 选择器显得重复，是因为四套体系同时存在：个人 skills、CLI 内置、compound-engineering 插件（45 个 ce-*）、其它官方/第三方插件。
核查 `~/.claude/settings.json` 的 `enabledPlugins` 后发现：大部分重叠插件早已禁用
（`frontend-design`、`pr-review-toolkit`、`superpowers`、`document-skills`、`playwright`、`codex`、`warp` 均为 false）。
因此 `frontend-design` 同名冲突实际不存在，`tdd` 也是唯一可直接调用的 TDD skill（superpowers 已禁）。

## 改动（全部可逆）

- [x] 禁用插件 `code-simplifier`：`settings.json` 中 `true` → `false`。
      理由：内置 `simplify` + `ce-simplify-code` + `ce-polish` 已覆盖，它只是重复的 sub-agent。
- [x] 个人 `diagnose` → `~/.claude/skills/_disabled/diagnose`。理由：`ce-debug` 覆盖（复现→根因→修复→回归）。
- [x] 个人 `frontend-design` → `~/.claude/skills/_disabled/frontend-design`。
      理由：`ce-frontend-design` 覆盖生产级前端；`baoyu-design` 继续负责 mockup/原型/slides 细分。

保留（定制或唯一）：`commit`(中文)、`tdd`、`triage`、`baoyu-design`、`improve-skill`、
`improve-codebase-architecture`、`engineering-judgment`、`grill-me`、`grill-with-docs`、各 `asc-*` 等。

## 恢复方式

```bash
# 恢复个人 skill
mv ~/.claude/skills/_disabled/diagnose ~/.claude/skills/diagnose
mv ~/.claude/skills/_disabled/frontend-design ~/.claude/skills/frontend-design
# 恢复插件：把 settings.json 里 code-simplifier 改回 true
```

## 待用户决定的可选项（未自动处理）

- `grill-me` 与 `grill-with-docs`：后者≈前者+更新文档，按使用习惯可二选一。
- 若想进一步精简 picker，主要体量在 compound-engineering 的 45 个 ce-*，但你明确要保留该插件。
