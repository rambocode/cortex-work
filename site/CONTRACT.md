# apps/site 组件契约（workflow agents 必读）

为 Cortex Desktop 官网落地页并行实现各组件。**所有人共享本契约 + `app/globals.css`（设计 DNA）+ `lib/dictionary.ts`（文案）**，禁止另起设计体系或新增依赖。

## 视觉论点

暖纸感「思考工作台」× 深海生物荧光。米白纸张是日间工作面，品牌**蓝紫发光水母**的荧光是「智能在思考」的发光时刻。冷暖对撞、安静而有生命感。
- **暖陶土橙 `--clay` = 动作与品牌**（主 CTA、eyebrow 强调）
- **蓝紫荧光 `--glow-*` / `--grad-jelly` = 氛围与智能**（光晕、水母、点睛词、focus）
- 克制：荧光是点缀不是主色；不要满屏渐变。默认亮色，支持暗色（暗色下水母更亮）。

## 绝对规则

1. **不新增任何 npm 依赖**；不 import 任何 `@cortex-work/*` 包。仅用 react / next。
2. **一切文案来自 `d`（Dict）**，组件内禁止硬编码中文/英文可见文案（aria-label 也尽量用 d，无对应键时可用中性英文）。
3. 组件签名统一：区块组件 `export default function X({ d, locale }: { d: Dict; locale: Locale })`。
   - `import type { Dict } from "@/lib/dictionary"`；`import type { Locale } from "@/lib/i18n"`。
4. 复用 `globals.css` 已有 class（见下「类清单」），不够时可加**少量 scoped CSS**：在组件里用 `<style>{`...`}</style>`（仅 client 组件）或新增到 globals.css 末尾（server 组件，需在文件顶部注释标明）。优先复用既有 class。
5. **语义化 HTML**：`<nav> <main> <section> <header> <footer> <button> <a>`；每个 section 一个 `id`（features/workflow/agents/download）。所有可交互元素有可见 focus（已全局提供 `:focus-visible`）。
6. **卡片仅在「卡片本身是交互单元」时用**（可点/可选）。纯展示用排版+留白，不要无脑套卡。
7. 动效走 `globals.css` 的 `.reveal` / `.anim-*` / keyframes，且必须在 `prefers-reduced-motion` 下静默（全局已处理 `.reveal`/`.anim-*`，自定义动画也要加 media query）。
8. 移动端必须可用：用 `clamp()`、`grid` 工具类、`@media (max-width: 760px)` 折叠。
9. 中英文都要排版良好：英文较长，注意换行不破版；标题用 `text-wrap: balance` 思路（可加内联 style）。
10. 注释用简体中文。

## 文件路径与产物

别名 `@/` = `apps/site/`。各 agent 只写自己负责的文件，**不要碰别人的文件**，不要运行 install/build/typecheck（仅「组装」阶段做）。

### Phase 1 品牌与插画
- `components/icons.tsx`：**具名导出**所有内联 SVG 图标（`stroke-width 1.7`、`viewBox 0 0 24 24`、`stroke="currentColor"` `fill="none"`，除非品牌色）。需提供：
  - 功能图标（对应 FeatureItem.icon）：`IconWorkspace, IconTeam, IconReview, IconAutomation, IconUsage, IconTerminal`
  - UI 图标：`IconDownload, IconGithub, IconArrowRight, IconSun, IconMoon, IconGlobe, IconCheck, IconSparkle`
  - 一个映射 `featureIcon: Record<FeatureItem["icon"], (p:{className?:string})=>JSX.Element>` 方便 Features 区块取用。
  - 每个图标签名：`export function IconX({ className }: { className?: string }) { return (<svg className={className} ...>...)}`。
- `components/brand.tsx`：`export function BrandMark({ withWord?: boolean })` — 小号水母标 + 文字「Cortex」。水母标用 `--grad-jelly`，~22–26px。
- `components/Jellyfish.tsx`（**hero 主视觉，签名级**）：`export default function Jellyfish({ className }: { className?: string })`。一只发光水母：伞盖用 `--grad-jelly` 渐变 + 内部高光，伞盖上散布发光白点（神经元意象，部分 `anim`/`sparkle` 呼吸），下垂 5–7 条飘动触手（可加 `sway`/drift 的 CSS），外圈柔和光晕（radial）。要求**精致、有体积感、像在水中漂浮**，不是简笔。viewBox 自定（约 0 0 420 520）。纯 SVG（可含 `<style>` 做内部动画，注意 reduced-motion）。可被 server 组件渲染（无 hooks）。
- `components/ui.tsx`：客户端小工具，三个具名导出：
  - `ThemeToggle`（"use client"）：读/写 `localStorage['cortex-theme']`，切换 `document.documentElement.dataset.theme`（light/dark），按钮内用 `IconSun/IconMoon`，`aria-label` 切换。挂载前避免 hydration 抖动（用 useEffect 读初值）。
  - `LangSwitch`（可 server）：`({ locale }: { locale: Locale })`，用 `next/link` 链到另一语言 `/${otherLocale(locale)}`，显示 `localeLabel`。`otherLocale`/`localeLabel` 来自 `@/lib/i18n`。
  - `Reveal`（"use client"）：`({ children, className?, i? }: {...})` 用 IntersectionObserver 在进入视口时给根元素加 `is-visible`；根元素 class = `reveal ${className??""}`，并设 `style={{['--i' as any]: i ?? 0}}`。一次性触发后断开。
- `app/opengraph-image.tsx`：用 `next/og` 的 `ImageResponse` 生成 1200×630 OG 图。**必须零外部字体/网络**（只用内联样式与系统字体，size 用默认）。暖纸底 + 品牌名 + 一抹蓝紫光晕。导出 `size`、`contentType`、默认 async 函数。若实现有风险，做成纯色块 + 文案的极简版，**保证 `next build` 不依赖网络**。

### Phase 2 区块组件（`components/sections/*.tsx`，default 导出）
顺序即页面顺序。每个组件读取 `d` 的对应切片：

1. `Nav.tsx`（"use client"，需滚动态/移动菜单）：sticky 顶栏，`glass` 质感。左 `BrandMark`，中锚点（`d.nav.features/workflow/agents` → `/${locale}#features|#workflow|#agents`），右 `LangSwitch` + `ThemeToggle` + 主 CTA「`d.nav.download`」(`.btn .btn--primary`，链到 `#download`)。移动端收进汉堡菜单。
2. `Hero.tsx`（可 server）：`<section>` 首屏。结构：`aurora`/`neuron-field` 氛围层 → 左文案（`eyebrow`=`d.hero.eyebrow`；`h1.display`=`d.hero.title` + 一行 `glow-text` 的 `titleAccent`；`lead`=`d.hero.sub`；两个 CTA：primary `d.hero.primary`(.btn--primary--lg，含 IconDownload，链 `#download`) + secondary `d.hero.secondary`(.btn--ghost，含 IconArrowRight，链 `d.links.webApp`)；`d.hero.trust` 小字 + `d.hero.note`）→ 右 `<Jellyfish>`（含 `anim-drift` 漂浮 + 光晕 halo）。移动端单列，水母在上或弱化。首屏文案做 staggered 入场（可用 `.reveal` 配 `--i`）。
3. `Agents.tsx`（id="agents"）：`d.agents`。标题区（eyebrow/title/sub）+ 三个 agent（`items`，**这是卡片**：可视作可选单元）展示 name/tag/desc，按 `key` 给不同品牌色描边/标记（claude 偏紫橙、codex 偏中性、pi 偏蓝紫荧光，自行定）。下方 `extra.title` + `providers` 一排 `pill`。
4. `Features.tsx`（id="features"）：`d.features`，6 个 `items` 的 `grid grid-3`（移动折叠）。每项：`featureIcon[item.icon]` 图标（放在小号荧光底圆里）+ `h3` + 描述。**判断卡 vs 非卡**：可用轻卡（`card card--pad card--hover`）因为是一组并列单元，hover 升起即可；图标用 clay 或荧光点缀。
5. `Workspace.tsx`（id="workflow"）：`d.workspace`。左**风格化的三栏工作台 mock**（用 div + 既有 token 自绘，不要截真图）：左窄栏列「会话」、中栏一条「实时」流式推理气泡（`d.workspace.mock.reasoning`）+ 文件名 `mock.file`/分支 `mock.branch`(mono)、一张 diff 卡片带 `approve`/`reject` 两个按钮（approve 用 clay/green）。右窄栏「上下文」。整体用 `--pw-float` 般的浮起卡片感（参考产品三栏浮起：中栏铺底、左右栏浮起）。右侧文案：title/sub + `points` 三条（每条带 `IconCheck` 荧光勾）。
6. `Automation.tsx`（id="download" 或单独）：`d.automation`。两栏：左「定时自动化」title/desc + `bullets`（带勾）；右「用量与节奏」用一张 mock 用量小卡（一个 7×5 的发光强度网格日历 + 两个统计 `stat1/stat2`）。氛围用一抹 aurora。
7. `FinalCTA.tsx`：`d.finalCta` + `d.links`。居中大区块，深色或荧光感强一档（可用 `--grad-jelly` 描边的大卡 / 或暗底光晕）。大标题 `title`、`sub`、primary「`primary`」(下载，链 `d.links.releases`) + secondary「`secondary`」(GitHub，链 `d.links.github`，含 IconGithub)，`note` 小字。**给这个 section 外层 `id` 之一应为 `download`** 若 Automation 未占用（二选一，组装阶段确认锚点唯一）。
8. `Footer.tsx`：`d.footer` + `d.brand`。`BrandMark` + `tagline`，`groups` 多列链接，`localFirst` 一行，`copyright`。底部可放 `LangSwitch`。

### Phase 3 组装
- 写 `app/[locale]/page.tsx`：`async` server 组件，`await params` 取 locale，`getDict`，按顺序渲染 `<Nav> <main> <Hero/><Agents/><Features/><Workspace/><Automation/><FinalCTA/> </main> <Footer>`，给各 section 包 `Reveal`（Hero 除外或首屏直接显示）。确保**锚点 id 唯一**（features/workflow/agents/download 各一处）。
- 运行 `pnpm --filter @cortex-work/site typecheck`，修到通过。

## 类清单（globals.css 已提供，直接用）

布局：`.container`(`.container-narrow`)、`.section`(`.section-sm`)、`.divider`、`.content`、`.grid`/`.grid-2/3/4`
版式：`.display .h1 .h2 .h3 .lead .muted .mono .eyebrow .glow-text`
按钮：`.btn` + `.btn--primary / .btn--ghost / .btn--quiet / .btn--lg`（含 svg 自动 18px）
标签/卡：`.pill`(`.pill--glow`)、`.dot`、`.card`(`.card--pad .card--hover`)、`.glass`
氛围：`.halo`、`.aurora`、`.neuron-field`
动效：`.reveal`(+`.is-visible`，`--i` 控制 stagger)、`.anim-drift / .anim-floaty / .anim-halo`，keyframes：`drift floaty haloBreathe sway sparkle shimmer`

token（节选）：`--clay --clay-deep --clay-soft`、`--glow-cyan/blue/violet/pink`、`--jelly-top/mid/low/deep`、`--grad-jelly --grad-glow --grad-aurora --grad-text`、`--paper --paper-raise --paper-sink --ink --ink-2 --ink-3 --line --line-strong`、`--r-sm/r/r-lg/r-xl/r-pill`、`--shadow-card/raise/pop/glow`、`--font-display/sans/mono`、`--maxw --gutter --section-y`。
