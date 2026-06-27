#!/usr/bin/env bash
# 把纯绿背景去成真透明(就地覆盖)。**不 trim**,保留完整画布,使各帧尺寸/基线不变。
# codex 通常已在生成时去过背;此脚本用于兜底或批量重处理。
#
# 用法:chroma-key.sh [--fuzz 18] <png...>
set -euo pipefail
FUZZ=18
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --fuzz) FUZZ="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 [--fuzz 18] <png...>"; exit 0 ;;
    *) files+=("$1"); shift ;;
  esac
done
[ ${#files[@]} -gt 0 ] || { echo "Usage: $0 [--fuzz 18] <png...>" >&2; exit 1; }
command -v magick >/dev/null || { echo "ImageMagick (magick) not found" >&2; exit 1; }
for f in "${files[@]}"; do
  magick "$f" -fuzz "${FUZZ}%" -transparent '#00FF00' "$f"
  echo "keyed: $f"
done
