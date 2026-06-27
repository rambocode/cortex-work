#!/usr/bin/env bash
# 把一组「同基线、全画布、透明」的角色帧拼成等宽 sprite sheet(WebP)。
#
# 逐帧处理:
#   - 归一到单元高的方画布(吸收不同源尺寸:idle 可能 1024²、其它 1254² 等);
#   - 取角色内容 bbox,把角色【水平居中】到单元中心;
#   - 【纵向位置(脚底基线)保持不变】。
# 结果:跨帧/跨状态的角色水平中心一致(无横向漂移)、脚底基线一致(无纵向漂移)。
#
# 帧文件需命名 frame_*.png,按自然序(frame_1, frame_2, ...)排列。
# --cell 用「显示尺寸 × 2」(retina):宠物显示 110×100 → --cell 220x200。
#
# 用法:
#   pack-sprite-sheet.sh --in <dir> --out <file.webp> [--cell 220x200] [--quality 90]
set -euo pipefail

IN_DIR=""; OUT=""; CELL_W=220; CELL_H=200; QUALITY=90
while [ $# -gt 0 ]; do
  case "$1" in
    --in) IN_DIR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --cell) CELL_W="${2%x*}"; CELL_H="${2#*x}"; shift 2 ;;
    --quality) QUALITY="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 --in <dir> --out <file.webp> [--cell 220x200] [--quality 90]"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -n "$IN_DIR" ] && [ -n "$OUT" ] || {
  echo "Usage: $0 --in <dir> --out <file.webp> [--cell 220x200] [--quality 90]" >&2; exit 1; }
command -v magick >/dev/null || { echo "ImageMagick (magick) not found" >&2; exit 1; }

shopt -s nullglob
frames=( "$IN_DIR"/frame_*.png )
[ ${#frames[@]} -gt 0 ] || { echo "no frame_*.png in $IN_DIR" >&2; exit 1; }
# 自然序排序(frame_2 在 frame_10 前)
IFS=$'\n' frames=( $(printf '%s\n' "${frames[@]}" | sort -V) ); unset IFS

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cells=()
for f in "${frames[@]}"; do
  base="$(basename "$f" .png)"
  # 1) 归一到单元高的方画布,统一各源尺寸 → 脚底相对基线一致
  norm="$tmp/${base}_n.png"
  magick "$f" -resize "${CELL_H}x${CELL_H}" -background none -gravity center -extent "${CELL_H}x${CELL_H}" "$norm"
  # 2) 取角色内容 bbox(WxH+X+Y)
  geo="$(magick "$norm" -format "%@" info:)"
  W="${geo%%x*}"; r="${geo#*x}"; H="${r%%+*}"; r="${r#*+}"; X="${r%%+*}"; Y="${r#*+}"
  # 3) 水平居中(cx),纵向 Y 保持不变 → 合成到 CELL_W×CELL_H 透明单元
  cx=$(( (CELL_W - W) / 2 ))
  cell="$tmp/${base}_c.png"
  magick "$norm" -crop "${W}x${H}+${X}+${Y}" +repage \
    \( -size "${CELL_W}x${CELL_H}" xc:none \) +swap \
    -gravity none -geometry "+${cx}+${Y}" -compose over -composite "$cell"
  cells+=("$cell")
done

magick "${cells[@]}" +append "$tmp/sheet.png"
magick "$tmp/sheet.png" -quality "$QUALITY" -define webp:method=6 "$OUT"
echo "packed ${#cells[@]} frames -> $OUT ($(magick identify -format '%wx%h' "$OUT"))"
