# 桌面宠物行为增强：底部走动 + 趴输入框

## 需求
1. 没有任何输入（idle）时，宠物沿应用底部边框来回走动；用户可主动关闭宠物。
   有输入/活动（typing/thinking/working/replying）时保持现有状态动画逻辑。
2. 新增「趴在输入框上」模式（参考图：只露头和搭在边上的前爪），同样有动画。
3. 以上行为可在设置页「宠物」分区配置。

## 设计决策
- store 增加 `mode: "free" | "walk" | "perch"`（默认 walk）与 `enabled: boolean`（默认 true），
  持久化沿用 views 层 localStorage 模式。
- walk：仅 `state === "idle"` 时走动（rAF 直改 DOM style，不经 React 重渲）；
  其他状态原地暂停并播放现有状态动画；sleeping 原地睡。向左走时水平翻转。
- 关闭：宠物悬停浮现 ✕ 按钮 → `enabled=false` 并持久化；设置页可重新打开。
- perch：锚定可见的 `.composer-wrap`（轮询 + resize），SVG 裁剪 viewBox 只露头部，
  叠加一对通用前爪（跟随 --pet-main 配色）搭在输入框上沿；无锚点时回退默认位置。
- 设置页：新增「行为 · Behavior」三选段 + 「显示宠物」开关。

## 任务
- [x] core pet store：mode / enabled + setters
- [x] pet/behavior.ts：stepWalk 纯函数 + mode/enabled 持久化 loaders
- [x] Pet.tsx：enabled 短路、walk rAF 循环、perch 锚定渲染、✕ 关闭按钮
- [x] CSS：走动步态/翻转、趴窗造型与爪子动画、关闭按钮
- [x] SettingsMenu：行为三选段 + 显示开关
- [x] 测试：behavior 纯函数/持久化 + Pet 组件（关闭、模式渲染）
- [x] vitest / lint / typecheck 全绿

## 执行结果
- core [pet.ts](../packages/core/store/pet.ts)：新增 `PetMode`、`mode`、`enabled` 与 setters。
- 【需求迭代】走动不再是独立模式，而是「自由放置」下的开关（`walk`，默认开）：
  - 开启后宠物常驻底部巡逻道；**安静满 10 分钟**（`WALK_IDLE_DELAY_MS`）才开始沿底边散步；
  - 一有事件（输入/思考/点击）立即停走，**CSS transition 平滑过渡回最右侧**待命（`.is-gliding`）；
  - 睡眠互动：安静 2–10 分钟打盹，满 10 分钟由 `wake()`（不刷新 lastActivity）唤醒去散步；
  - 旧 localStorage 值 `mode="walk"` 自动迁移为 `free`；设置页为两选段 + 「闲时底部走动」开关（仅自由放置时显示）。
- 新增 [behavior.ts](../packages/views/cortex-desktop/pet/behavior.ts)：`stepWalk` 边界反弹纯函数、
  WALK 参数常量、mode/enabled localStorage 读写。
- [Pet.tsx](../packages/views/cortex-desktop/pet/Pet.tsx)：
  - `enabled=false` 不渲染；✕ 悬停按钮（所有模式）关闭并持久化；
  - walk：idle 时 rAF 走动（直改 style 不触发重渲），边缘折返、向左翻转、步态动画；
    非 idle 原地暂停播放现有状态动画；free 模式拖拽逻辑保持不变（walk/perch 禁用拖拽）；
  - perch：600ms 轮询 + resize 监听锚定 `.composer-wrap`；**每个造型有专属趴姿**
    （designs.tsx 拆出 CatHead/ShibaHead/BunnyHead/RobotHead 复用，新增
    CatPerch/ShibaPerch/BunnyPerch/RobotPerch：头 + 颈胸绒毛 + 垂搭在框沿的
    带趾线前爪，机器人为颈柱 + 机械夹爪），框沿基线 PERCH_EDGE_Y=80 对齐输入框
    上沿，爪子垂搭进框内 ~14px；整体轻起伏 + 双爪交替扒沿动画；
    找不到锚点回退右下默认位。
- [SettingsMenu.tsx](../packages/views/cortex-desktop/personal/SettingsMenu.tsx)：宠物分区新增
  「显示宠物」开关 + 行为三选段（自由放置/底部走动/趴在输入框）。
- 测试：behavior.test.ts 8 用例 + Pet.test.tsx 7 用例；views 全套 vitest、lint、tsc 通过。
- 美术精修（用户反馈「有点粗糙」后）：搭临时 HTML 预览 + Chrome 截图自查迭代 3 轮——
  - 共享 Eyes 重绘：杏仁眼形、虹膜（带深色缘）+ 竖瞳 + 双高光、上睑睫毛线，
    各造型专属虹膜色（猫绿/柴棕/兔褐/机器人荧绿）；
  - 猫/柴头部：弧形耳廓 + 耳口绒毛、贴轮廓弧形碎毛（FurTufts）、浅色口吻区、
    立体鼻头（鼻孔 + 高光）、弧形胡须 + 胡须点、虎斑side纹/柴犬眉点细化；
  - 趴姿爪子：底缘四趾瓣鼓包 + 趾缝 + 腕侧碎毛；胸毛改尖刺绒毛轮廓；
  - 兔子保持光滑轮廓（不加碎毛），机器人加屏幕扫描线 + 四角铆钉。
- UI 动画手感留待用户手动验证（按既有分工）。
