# 内置 skill 清单

本目录内的 skill 随 Cortex Desktop 安装包内置分发（`electron-builder.yml` 的 `extraResources`，落到 `<App>/Contents/Resources/skills/`）。内容分**自研**与 **vendoring** 两类，维护方式不同。

## 一、自研（唯一真源在本仓库）

| skill | 说明 |
|---|---|
| `incident-apology-report` | 把一段随口的故障描述转成可直接发客户的《故障/异常情况说明及致歉报告》Word 文档 |
| `contract-review-report` | 按甲方/乙方/中性视角审查合同风险，产出 Markdown + 可打印 HTML 报告 |
| `knowledge-base` | 规范公司知识库（`kb_*` MCP 工具）的检索与沉淀方式：先检索再定点读、结论必须可追溯、冲突不自行裁决 |

- **本目录这份即唯一维护点。** 二者原始出处是本机目录 `/Users/mike/source/ai/skills/cortex-desktop/`，拷入时已按内置需要改造（行业措辞泛化、缺依赖降级、补 `argument-hint`、去 `agents/`），**与源目录已分叉、不再双向同步**；源目录仅作历史存档。仓库内没有、也不应有 skill 同步脚本。
- 二者都依赖 `python3`：`incident` 另需 `python-docx`（缺失时脚本自动降级输出 Markdown，退出码 0）；`contract` 的 `render_report.py` 只用标准库，pandoc / markdown 库均为可选降级项。
- `knowledge-base` 无任何脚本依赖，纯 SKILL.md。它描述的 `kb_*` 工具由**远端**知识库 MCP server 提供（见 `main/capabilities/knowledge/inject.ts`，server 实现在 `../../knowledge-base-system` 的 `/api/mcp`），未接入时 skill 内已写明降级指引——不会让 agent 假装查过知识库。工具集若增删，本文件与该 skill 的「检索的正确顺序」一节要同步。

## 二、vendoring（来自 compound-engineering 插件）

- 来源：`compound-engineering` 插件
- 版本：`3.12.0`
- 许可：见同目录 `LICENSE`
- 范围（6 个）：`ce-brainstorm` / `ce-doc-review` / `ce-frontend-design` / `ce-ideate` / `ce-plan` / `ce-work`
- 升级内置版本时同步更新上面的版本号。

## 三、产品内建 stub

`design` / `slides` 是 artifact 派发专用的薄 SKILL.md，由 `packages/views/cortex-desktop/personal/artifactDispatch.ts` 按名取用，不属于上面两类。

## 两条消费链（改本目录前务必看懂）

本目录被**两套互不相通**的机制读取：

1. **按名硬编码取用** —— `main/skills/registry.ts` 的 `skills:get` / `skills:get-builtin` / `skills:list` IPC。真实调用点只有 `core/personal/notes.ts`（闪记深化取 `ce-ideate` / `ce-plan`）与 `views/.../artifactDispatch.ts`（取 `design` / `slides`）。**只把 skill 放进本目录，不会让它出现在 `/skill:` 菜单里，也不会注入会话。**
2. **会话 skill 链** —— `/skill:` 下拉、`SkillPanel` 列表与发送时注入（`core/personal/piSkills.ts`、`skill-injection.ts`），扫描根来自 `DEFAULT_SHARED_SKILL_ROOTS`（`~/.cortex-desktop/skills`、`~/.agents/skills`）等，**默认不含本目录**。

要让一个内置 skill 真正对用户可用（即接上第 2 条链），必须把它加进 `main/ipc/skills.ts` 的 `DEFAULT_BUILTIN_SKILLS` 白名单——`pi-skills:list` 会据此把对应目录以 `scope: "global"` 并入扫描根。`ce-*` 与 `design` / `slides` 刻意不在白名单内：它们只服务第 1 条链，涌进菜单反而是负价值。

⚠️ 白名单根是 **unshift 到扫描根最前**的，不能改成 push：注入侧 `resolveEnabledSkillRecords` 与菜单侧 `filterEnabledPiSkills` 的同名去重都是「后扫到的 global 覆盖前者」，排在后面会让内置版反过来盖掉用户放在 `~/.cortex-desktop/skills/` 的同名 skill，用户就再也改不掉了。用户覆盖内置版，靠的正是在自己目录放一个同名 skill。该顺序契约有单测守着（`main/ipc/skills.test.ts` 的「内置默认 skill 并入」）。

## 升级 / 第二阶段

第二阶段「初始化下载官方 skill 库」会把下载的 skill 落到 `userData/skills/<name>/`，registry 双源去重时 userData 优先覆盖内置（见 `apps/desktop/src/main/skills/locate.ts`、`download.ts`）。

## 其它约定

- 每个 skill 一个目录，目录名 == `SKILL.md` frontmatter 的 `name`（registry 与白名单均据此定位）。
- 主进程 registry（`apps/desktop/src/main/skills/`）只解析 frontmatter 的 `name` / `description` / `argument-hint` / `supported-agents` 四键；`supported-agents` 缺省 = 对全 agent 可见。
- 闪记深化在 headless `claude -p` 下**降格执行**（单 agent、禁子 agent、禁阻塞提问），不依赖各 skill 内部的 `agents/` 子 agent 编排（`agents/` 一律不内置）。
