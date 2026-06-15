# 内置 skill 来源

本目录内的 skill 由 [compound-engineering](https://github.com/) 插件 vendoring 而来，随 Cortex Desktop 安装包内置分发（`electron-builder.yml` 的 `extraResources`）。

- 来源：`compound-engineering` 插件
- 版本：`3.12.0`
- 许可：见同目录 `LICENSE`
- 内置范围（6 个）：`ce-brainstorm` / `ce-doc-review` / `ce-frontend-design` / `ce-ideate` / `ce-plan` / `ce-work`

## 约定

- 每个 skill 一个目录，目录名 == `SKILL.md` frontmatter 的 `name`（registry 据此按 name 定位）。
- 主进程 registry（`apps/desktop/src/main/skills/`）只解析 frontmatter 的 `name` / `description` / `argument-hint` 三键。
- 闪记深化在 headless `claude -p` 下**降格执行**（单 agent、禁子 agent、禁阻塞提问），不依赖各 skill 内部的 `agents/` 子 agent 编排（`agents/` 未内置）。

## 升级 / 第二阶段

第二阶段「初始化下载官方 skill 库」会把下载的 skill 落到 `userData/skills/<name>/`，registry 双源去重时 userData 优先覆盖内置（见 `apps/desktop/src/main/skills/locate.ts`、`download.ts`）。升级内置版本时同步更新本文件版本号。
