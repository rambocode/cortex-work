---
name: codex-image-assets
description: 用 Codex CLI 的内置 image_gen 工具生成位图图片资产——尤其是桌面宠物(pet)的 2D 序列帧 sprite sheet。包含参考图角色锚定、绿幕 chroma-key 透明、以及 ImageMagick 确定性拼接(逐帧水平居中 + 脚底基线对齐)成等宽 WebP sprite sheet。当需要创建/更新宠物 sprite(idle/walk/happy/sleeping 等)或其它角色/精灵位图资产时使用。触发词:宠物资产、sprite、序列帧、image_gen、codex 生成图片、角色立绘、透明 PNG 资产。
---

# Codex 图片资产生成

用 **Codex CLI 内置 `image_gen` 工具**(走 codex 自己的鉴权,**不需要** `OPENAI_API_KEY` / `GEMINI_API_KEY`)生成位图资产,再用 **ImageMagick** 确定性后处理。核心场景:本仓库桌面宠物的逐帧 sprite sheet。

## 前置条件

- `codex` CLI(`codex exec` 可非交互运行;`codex --version` 确认)。
- ImageMagick(`magick`),用于去背 / 切分 / 拼接 / 转 WebP。
- (可选)`rsvg-convert` 或 `qlmanage`:浏览器级渲染 SVG 预览(ImageMagick 的 SVG 渲染器对嵌套 transform 支持弱,会误判)。

## 管线总览

```
参考图锚定 ─▶ codex image_gen 逐帧生成(纯绿背景) ─▶ 绿幕→真透明(不 trim) ─▶
ImageMagick 拼接(逐帧水平居中 + 纵向脚底基线保持) ─▶ 等宽 WebP sprite sheet ─▶ 接入 manifest
```

分工:**codex 负责"生成 + 去背"**(创意 + 角色一致性),**脚本/ImageMagick 负责"拼接"**(确定性、保证网格对齐与零漂移)。

## 步骤

### 1. 准备角色参考图(跨帧/跨状态一致性的关键)

同一角色要在多帧、多状态间保持一致,**必须**用一张基准图锚定。若已有该角色的某张干净立绘(如现有 sprite 的第 1 帧),抠出来放大作参考:

```bash
magick <某张干净立绘> -resize 768x768 -background none -gravity center -extent 768x768 /tmp/ref/char_ref.png
```

首次创建(无现成图)时:先只生成 1 帧基准图,人工确认满意后,再以它为参考生成其余帧/状态。

### 2. 写每状态的帧提示词

每个动画状态写一个提示词文件,遵循 `references/prompt-template.md` 的约定。**硬约束(务必写进提示词)**:

- 背景:整幅 **纯绿 `#00FF00`** 平涂(用于 chroma-key),无渐变/阴影/地面/文字/边框。
- 角色锚定:严格保持参考图里的同一角色(同脸/同色/同描边/同体型),只改本帧描述的姿态。
- **脚底基线固定**:每一帧、每个状态,角色脚底落在画布**同一条水平线**(约画布高 **78%** 处),水平居中。这是"切状态不漂移"的根本。
- **不要 trim**:去背时保留完整画布,使所有帧尺寸一致、基线不变(用 `magick IN -fuzz 18% -transparent '#00FF00' OUT`,**不加 `-trim`**)。
- 画布统一正方形(如 1024×1024),四周留白一致。

### 3. 调 codex 生成(后台 + STDIN 传 prompt)

**两个必须避开的坑:**

1. **`-i` 是可变参数**:`codex exec -i ref.png "<prompt>"` 会把 prompt 也当成图片吞掉。**prompt 必须经 STDIN 传入**,`-i` 只带参考图。
2. **图像生成耗时数分钟**:前台会被 120s 超时杀掉。**用后台运行**(harness 的 `run_in_background`)。

用封装脚本:

```bash
# 每个状态一次(可并行多个后台任务,各写不同 out-dir)
bash .claude/skills/codex-image-assets/scripts/generate-frames.sh \
  --ref /tmp/ref/char_ref.png \
  --prompt /tmp/prompts/idle.txt \
  --out-dir tmp/frames/idle \
  --cwd "$PWD"
```

脚本内部即 `codex exec -C <cwd> -s workspace-write --skip-git-repo-check -i <ref> < <prompt>`。生成完成后**逐帧目检**:角色一致?脚底齐?无绿边?

### 4. 拼成等宽 WebP sprite sheet

```bash
bash .claude/skills/codex-image-assets/scripts/pack-sprite-sheet.sh \
  --in tmp/frames/idle --out packages/views/cortex-desktop/pet/assets/cat/idle.webp \
  --cell 220x200
```

`pack-sprite-sheet.sh` 对每帧:归一到单元高 → 取角色 bbox → **水平居中到单元中心**、**纵向位置(脚底)保持不变** → 拼成等宽 sheet → WebP。这同时保证:

- 跨帧/跨状态**水平中心一致** → 切状态无横向漂移。
- 脚底基线保持 → 无纵向漂移。

`--cell` 用**显示尺寸的 2 倍**(retina 更清晰):宠物显示 110×100 → `--cell 220x200`。

### 5. 接入 manifest 与渲染

宠物的具体接线(资产路径、`sprites.ts` manifest、CSS `steps()` 渲染约定、fps 取值)见 `references/pet-workflow.md`。

## 校验技巧

- **脚底/水平对齐**:把不同状态的两帧叠加,确认重合:
  `magick <A帧> <B帧> -gravity center -compose over -composite -background "#e8e8e8" -flatten /tmp/overlay.png`,再看图。
- **逐帧水平中心**:`magick sheet.webp -crop <cellW>x<cellH>+<i*cellW>+0 +repage -format "%@" info:` → `WxH+X+Y`,中心 `X+W/2` 各帧应趋同。
- **SVG 预览**别用 `magick`(嵌套 transform 渲染不准),用 `rsvg-convert in.svg -o out.png`。

## 已知坑速查

| 坑 | 后果 | 对策 |
|---|---|---|
| `-i` 吞掉 prompt | "No prompt provided via stdin" | prompt 走 STDIN,`-i` 只带参考图 |
| 前台跑 codex | 120s 超时被杀 | 后台运行 |
| 去背带 `-trim` | 各帧尺寸不一、基线漂移 | 去背不加 `-trim`,保留画布 |
| 只统一画布居中、没居中角色 | 横向漂移(切状态左右跳) | 拼接时按角色 bbox 水平居中 |
| 脚底基线没固定 | 纵向漂移(切状态上下跳) | 提示词钉死脚底 78% + 拼接保持 Y |
| CSS `steps(N-1)` | 两帧重影(半帧+半帧) | 百分比法用 `steps(N, jump-none)` |
| ImageMagick 预览 SVG | 误判"没渲染出来" | 用 rsvg-convert/qlmanage |
