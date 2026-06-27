# 桌面宠物 sprite 资产接线

宠物代码:`packages/views/cortex-desktop/pet/`。渲染从 SVG 改为 sprite 序列帧后,真实资产由本 skill 产出。

## 资产规格

- 角色:`cat` / `shiba` / `bunny` / `robot`(`PetKind`)。
- 核心动画键(`SpriteAnimKey`):`idle` / `walk` / `happy` / `sleeping`。其余状态(typing/thinking/working/replying)复用 idle + SVG 配件叠加层。
- 资产路径:`packages/views/cortex-desktop/pet/assets/<kind>/<state>.webp`。
- 单元(cell):**220×200**(= 显示 110×100 的 2×,retina)。sheet 宽 = 帧数 × 220,高 200。
- 帧数参考:idle 4、walk 4、happy 5、sleeping 3。

## 完整流程(以 cat 为例)

```bash
WT="$PWD"                 # 仓库/worktree 根
OUT=packages/views/cortex-desktop/pet/assets/cat
SK=.claude/skills/codex-image-assets/scripts

# 1) 参考图(从现有某帧抠;首建时先单独生成 1 帧确认)
mkdir -p /tmp/ref
magick "$OUT/idle.webp" -crop 220x200+0+0 +repage -resize 768x768 \
  -background none -gravity center -extent 768x768 /tmp/ref/cat_ref.png

# 2) 各状态提示词 → 后台并行生成(prompt 走 STDIN,-i 只带参考图)
#    (用 harness 的 run_in_background 跑;每个状态一个后台任务)
bash $SK/generate-frames.sh --ref /tmp/ref/cat_ref.png \
  --prompt /tmp/prompts/idle.txt --out-dir tmp/frames/idle --cwd "$WT"
# ...walk / happy / sleeping 同理

# 3) 拼成等宽 WebP(逐帧水平居中 + 脚底基线保持)
for st in idle walk happy sleeping; do
  bash $SK/pack-sprite-sheet.sh --in tmp/frames/$st --out "$OUT/$st.webp" --cell 220x200
done

# 4) 校验:两态叠加确认零漂移
magick \( "$OUT/idle.webp" -crop 220x200+0+0 +repage \) \
       \( "$OUT/happy.webp" -crop 220x200+$(( (5-1)*220 ))+0 +repage \) \
       -gravity center -compose over -composite -background "#e8e8e8" -flatten /tmp/overlay.png
```

## manifest:`pet/sprites.ts`

每个 `SpriteAnim`:`{ src, frames, frameW, frameH, fps, loop }`。

- `frameW/frameH` = **110/100**(设计单位,非 sheet 像素;百分比渲染不依赖其绝对值)。
- `frames` = sheet 帧数(必须与 sheet 实际格数一致)。
- `loop`:`true` 循环 / `false` 播一次停末帧(happy)/ `"pingpong"` 往复(sleeping)。
- `fps`:节奏慢而柔(关键帧非补间),`dur = frames/fps`。参考:idle ≈ 2、walk ≈ 5、happy ≈ 6、sleeping ≈ 1.5。
- 资产用纯 ESM `import ... from "./assets/cat/idle.webp"`;`assetUrl()` 归一化 Vite(字符串)/ Next(对象)两端差异。
- 新角色出齐 4 态后,在 `PET_SPRITES` 增该 kind;`hasSprites(kind)` 即转为 true,Pet.tsx 自动走 sprite。

## 渲染约定:`pet/SpriteLayer.tsx` + CSS

**百分比 sprite 法**(尺寸无关,随 `--pet-scale` 缩放):

```css
.pet-sprite{
  background-size: calc(var(--sprite-frames) * 100%) 100%;
  animation: pet-sprite-run var(--sprite-dur) steps(var(--sprite-steps), jump-none) infinite;
}
@keyframes pet-sprite-run{ from{background-position-x:0%} to{background-position-x:100%} }
```

- **`--sprite-steps` 必须 = 帧数 N**(不是 N-1)。`steps(N, jump-none)` 在 0%→100% 停 N 个位置恰好命中 N 帧;用 N-1 会停在两帧之间出现「半帧+半帧」重影。
- `data: URI` 资产要 `url("...")` 双引号包裹(内联时含括号/引号,裸 `url()` 解析失败)。
- 切不同动画键时给 `.pet-sprite` 设 `key`(按动画键)重挂载,使一次性 / pingpong 动画重头播放;同映射到 idle 的状态不变 key,保持连续。

## 防漂移检查清单(每次出图必过)

1. 提示词钉死「脚底 78% + 水平居中 + 不 trim」。
2. 拼接用 `pack-sprite-sheet.sh`(逐帧水平居中 + 纵向保持)。
3. 叠加两态确认重合;逐帧量 `X+W/2` 应趋同(≈ cellW/2)。
4. manifest `frames` 与 sheet 实际格数一致;`steps = N`。
