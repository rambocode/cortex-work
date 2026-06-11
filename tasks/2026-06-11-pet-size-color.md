# 桌面宠物:尺寸可调 + 颜色自定义

## 需求
- 宠物尺寸可以调整(支持调大,默认 1×,范围 0.8×–2×)
- 宠物颜色可自定义(主色一键换,深色/浅色自动派生;不选则用各造型默认配色)

## 方案
- `packages/core/store/pet.ts`:PetStore 增加 `size` / `color` 及 setter
- `packages/views/cortex-desktop/pet/designs.tsx`:
  - 主题色改为 CSS 变量 `--pet-main / --pet-dark / --pet-light`,fallback 为各造型原默认色
  - 新增 `petColorVars(hex)`:由主色经 HSL 派生 dark(压暗)/ light(提亮)
  - 新增 size / color 的 localStorage 持久化(沿用 PET_KIND_KEY 模式)
- `pet/Pet.tsx`:启动时恢复 size/color;SVG 宽高与拖动边界按 size 缩放;颜色变量挂根节点
- `SettingsMenu.tsx` PetSection:尺寸滑杆 + 颜色预设/取色器 + 恢复默认;预览卡片同步配色
- `cortex-desktop.css`:阴影宽度随 `--pet-scale` 缩放;设置面板新控件样式

## 清单
- [x] core store 增加 size / color
- [x] designs.tsx 颜色变量化 + 派生/持久化工具
- [x] Pet.tsx 应用缩放与配色
- [x] 设置面板 UI(尺寸滑杆 80%–200% + 6 预设色 + 取色器 + 默认按钮,预览卡片实时跟随配色)
- [x] CSS 配套(.pet-shadow 随 --pet-scale 缩放;.pw-pet-size / .pw-pet-colors 控件样式)
- [x] 类型检查 / 测试通过

## 执行结果
- `pnpm typecheck`:5/5 通过
- `pnpm test`:core 41 + views 17(新增 designs.test.ts 7 个用例)全部通过
- 非主题色细节(粉色内耳、腮红、机器人屏幕等)保持原样,只统一三档主题色,避免自定义色破坏造型辨识度
- 尺寸变化时拖动边界与已存位置会自动夹回可视区

## 遗留
- 无
