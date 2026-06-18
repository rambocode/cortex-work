# i18n 迁移状态(中文 + 英文)

实现自 `docs/plans/2026-06-18-002-feat-i18n-zh-en-foundation-and-extraction-plan.md`,分支 `feat/i18n-zh-en`。

## 已完成(基建 + 主要 UI 表面)

**基建(U1–U5)**
- `@cortex-work/core/i18n` 全局默认 i18next 单例:zh-Hans 默认/源/回退,common 同步打入,其余命名空间懒加载,`useSuspense:false`。两层结构:无框架数据层(`locales`/`native`/`resources`)+ react 绑定层。
- `language` 接入 `Tweaks`,仿 `theme` 经 localStorage 持久化(`useTweaksPersistence`),同步 `documentElement.lang`。
- 设置「通用」区语言切换器(中文 / English),即时生效 + 跨会话保持。
- 工具链:`i18next-cli`(`i18n:extract`/`i18n:status`/`i18n:types`)、`eslint-plugin-i18next` 的 `no-literal-string`(warn 基线)、生成式 key 类型、`.github/workflows/i18n.yml`(非阻断)。
- 测试基建:`loadAllResourcesForTest` 同步灌入全部命名空间,组件/核心测试 `t()` 首渲染即返回真实 zh 值。

**跨进程(U12)**
- 桌面三独立渲染进程各持单例;主进程 `setLocale` → `getAllWindows` 广播 `app:locale` + 重建托盘菜单;次级窗口(notes-overlay/spotlight)订阅广播同步语言。
- 主进程托盘串走 `@cortex-work/core/i18n/native`(零 react,经 `externalize exclude` 打包)。

**已提取命名空间(739 key,8 命名空间,zh/en 全对齐)**

| 命名空间 | 单元 | 范围 |
|---|---|---|
| common | U6 | 共享 chrome:TitleBar/Sidebar/Sections/RightPanel/OrgSwitcher/UpdateButton/TweaksPanel/CortexDesktopView + todoUntitled |
| settings | U7 | SettingsMenu 8 分区(264 key) |
| spotlight | U7 | SpotlightBar |
| chat | U8 | ChatArea/ComposerShell/messages.ts |
| notes | U9 | NotesView/notes.ts/overlay |
| files | U10 | FilesView |
| timeline | U10 | TimelineView/HomeView/timeline.ts |
| pet | U11 | pet/Pet + 宠物造型 |

**持久化危险处理(绝不让翻译 key 落盘)**
- `PROVIDER_PRESETS.name` → `nameKey`,`providerFromPreset` 创建时解析为具体本地化串(保护测试在 `providers.test.ts`)。
- 「未命名 Todo」改持久空串,`TodosView` 渲染时 `title || t("common:todoUntitled")`。
- 时间线「AI 日报」/「全局日报」持久 title 不动,`TimelineView` 按 `event.kind` 渲染时派生。

**验证**:全仓 `pnpm typecheck`(5/5)、`pnpm test`(1173 测试通过)、`pnpm build:desktop` 均绿;`pnpm lint` 通过(no-literal-string 为 warn)。

## 剩余工作(后续)

1. **长尾提取(~608 处)**:`packages/views/cortex-desktop` 中本计划单元未枚举的组件仍含硬编码中文(如其余 personal/ 视图、agents/usage 等)。逐组件按相同模式提取到对应命名空间即可。`pnpm lint` 的 `no-literal-string` warning 即为待办清单。
2. **全局 lint 棘轮 + 阻断 CI**:长尾清零后,把 `eslint-config` 的 `no-literal-string` 升 `error`、移除 `i18n.yml` 的 `continue-on-error`、`i18next.config.ts` 的 `removeUnusedKeys` 翻 `true` 清理残留。
3. **英文复数**:count 类 key(如 `timeline:stats.*`)目前 zh 单形可用;如需地道英文复数,补 `_one`/`_other`。
4. **`i18next-cli status` 误报**:经 `t` 参数传入的辅助函数(如 `TimelineView` 的 `displayEventTitle`)其 key 无法被静态分析归到命名空间,status 会误报「absent」;运行期正确(测试已证)。

## 已知有意保留为字面量
- 品牌/专有名:Claude Code / Codex / Pi / Sonnet 4.5 等。
- 语言自名(endonym):TTS 语言名「中文 zh」「日本語 ja」等。
- 示例 Skill 文件名 `推送格式-日报.md`(磁盘路径产物)。
- `apps/desktop/src/main/ipc/fs.ts` 写入 md 文件正文的「未命名 Todo」(一次性内容快照,非 UI chrome)。
