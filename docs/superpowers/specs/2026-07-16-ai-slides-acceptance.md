# AI Slides 验收记录(Task 12)

对应计划 `docs/superpowers/plans/2026-07-16-ai-slides.md`、规格
`docs/superpowers/specs/2026-07-16-ai-slides-design.md`。本文件只记录**实测结论**:
每条都注明是自动化用例、真机验证,还是**尚未验证**。

## P2 产品完整度增量（2026-07-17）

对应计划 `docs/superpowers/plans/2026-07-17-ai-slides-product-completeness.md`。

### 已由自动化验证

- 演讲者备注：窄 IPC、revision 冲突、切页/关闭/卸载 flush、600ms 自动保存、
  `Cmd/Ctrl+S`、可调高度、快捷键 `N`、当前页 AI 生成入口及受 Slides 合同约束的 prompt。
- 角色流水线：五类固定角色 schema、条目/字节上限、原子持久化、恢复、取消、
  delegate 生命周期、异常退出收口、批准/拒绝/revision 冲突和 notes 审阅 gate。
- 质量闭环：按栅格覆盖面积计算 high/mixed/raster-heavy，导出前逐页展示原生对象、
  降级原因和优化入口；Narrative/Render findings 进入检查面板。
- 原生映射：语义 bar/line/pie chart、inline SVG、图片 object-fit/object-position、
  列表/段落间距/垂直对齐、简单旋转与透明度、表格 rowspan/colspan；不支持的 CSS
  继续栅格化并报告 warning。
- Electron fixture 已从默认并发测试池隔离，导出 fixture 可串行稳定执行。
- 审查回归：备注旧响应、pipeline 终态复活、notes 半提交、批准 TOCTOU、symlink
  逃逸、委派异常、超大输入、mixed-content 丢字和非法 chart id 均有定向测试。
- 当前源码已重新执行 arm64/x64 `prepackage` 与签名打包，双架构均生成 DMG/ZIP；
  未复用旧包。x64 包按既有平台约束不携带仅支持 darwin-arm64 的 Whisper runner。

### 本轮仍需人工/真机复验

1. 真实 Agent 凭据下完整跑通 research/review/notes 三类流水线，并验证应用重启恢复。
2. 在 PowerPoint（本机仍未安装）中逐项编辑 chart、SVG、裁剪图片、列表和合并单元格。
3. 在打包 GUI 内走“生成备注 → 导出 PPTX/HTML presenter → 查看备注”的完整路径。

## 自动化测试与静态检查

| 项 | 结果 |
|---|---|
| `@cortex-work/core` 全量 | 2513 通过 |
| `@cortex-work/views` 全量 | 1524 通过 / 3 skipped |
| `@cortex-work/desktop` 全量 | 2174 通过 / 1 skipped；默认命令连续两次通过 |
| 三包 typecheck | 全部干净 |
| `pnpm lint` | exit 0(仅既有 warning 基线,无新增 error) |
| 单文件行数上限 1200 | 新增文件最大 716 行(`capabilities/slides/workspace.ts`) |

Slides 相关新增用例约 210 个,分布:core 域类型/schema/路径/模板解析、desktop
workspace/IPC/MCP 工具/render/check/inspect/export、views store/缩略图/舞台/工具栏/
提纲面板/检查面板/编辑 bridge/模板选择器/右栏上下文。

## 真机验证(已实测)

### PPTX 可编辑性(硬门槛)
用 Keynote + AppleScript 打开 fixture deck 枚举原生对象:

```
slides=4 | slide1: textItems=6 images=0 firstText=AI Slides 技术验证
        | slide3: tables=1 textItems=3 | slide4: images=1 textItems=3
```

- 文本页:6 个原生文本项、0 图片(完全没有整页截图);
- 表格页:1 个原生 table;
- 复杂页:仅 1 张 base raster 底图,标题仍是原生文本;
- **写入验证**:`set object text of text item 1` 改写成功 → 文本真可编辑。

### PDF
真实 `printToPDF`(组合文档一次导出):4 页、`MediaBox [0 0 960 540]`
(= 1280×720 CSS px × 0.75,精确 16:9);复杂页的渐变背景 + canvas 柱状图 + 光晕圆齐全。

### HTML presenter
隐藏窗口真实播放:计数 `1 / 4` →(3×ArrowRight)`4 / 4` →(Home)`1 / 4`;
复杂页 canvas 实测像素 `rgba(56,189,248,255)`,与 fixture 首根柱子的 `#38bdf8` 一致
(证明页内脚本在 presenter 里真的跑了)。

### 两处 iframe sandbox 的硬约束(实测踩出,勿"收紧")
| 配置 | 后果 |
|---|---|
| 仅 `allow-same-origin` | 内联脚本被禁 → canvas/图表页导出**空白** |
| 仅 `allow-scripts` | frame 变 OOPIF → `printToPDF` **丢背景渐变** |
| `allow-scripts allow-same-origin`(采用) | 两者皆正常;仍拦住弹窗/下载/顶层跳转/表单/modal —— 正是页面合同的禁令 |

### 模板配色兜底(实测踩出)
QoderWork 模板 `template.json` 的 colors 不可靠:`text`/`textSecondary` 常错位
(quiet-axis 的 text 反而是浅色);`pixel-orbit` 标 `category: dark`、描述是 navy,
`colors.background` 却是粉色且两个文字候选都是亮色。归一化因此:先按对比度择优,
仍不达 WCAG AA(4.5)则按背景明暗回落黑/白。**35 套模板现已全部满足正文对比度**
(有用例守住)。

## 打包验收

- arm64 `prepackage:mac-arm64` + `build:mac-arm64`:成功,已签名
  (Developer ID Application: Jiangwei Lan);产出 zip + dmg。
- x64 `prepackage:mac-x64` + `build:mac-x64`:成功,已签名;产出 zip + dmg。
  主程序二进制经 `file` 确认为 x86_64；Whisper runner 因仅提供 darwin-arm64
  构建而按预期跳过。
- 模板资源已加入 `extraResources`,打包后 `Contents/Resources/slides/templates` 含 **35 套**。
- `pptxgenjs` / `jszip` 在 asar 内:**仓库外**用打包应用自带 runtime
  (`ELECTRON_RUN_AS_NODE=1`)真实 require 并生成 **44,791 字节**含备注的 PPTX,
  无 `Cannot find module`。
- 打包 main bundle 静态核验:`slides:*` IPC、`cortex-slides` MCP host、模板根解析、
  提纲 gate、`place_slide_html`、DOM 提取标记均在包内;preload 只暴露 `slides*` 窄面。

## 尚未验证(遗留)

1. **打包 GUI 内的端到端导出**:打包应用有自己的 main 入口,不能当通用 Electron
   runner 驱动脚本;真正的「启动打包应用 → 建 deck → 生成 → 四种导出」需要
   一次交互式真机会话(且要真实 Agent 与模型凭据)。当前证据链是:导出管线的
   单测(假窗口)+ fixture 真机渲染(Keynote/PDF/presenter)+ 打包态依赖真解析。
2. **真实 Agent 端到端**:「输入主题 → 批准提纲 → 生成 10 页 → 编辑 → 导出」未跑;
   三 Agent(Claude/Codex/Pi)工具名与权限一致性靠注入代码路径与单测覆盖,
   未做三端真机对跑。
3. **性能基线**:10 页 deck 的截图/导出耗时未在真机采样(单页截图 10s、10 页
   PPTX 90s 的门槛已在代码里设为超时,但未实测分布)。
4. **PowerPoint**:本机未安装,可编辑性验证走的是 Keynote(已确认原生对象与改写)。
