#!/usr/bin/env bash
# 用 Codex 内置 image_gen 生成一组角色帧(纯绿背景 → 真透明 PNG)到 out-dir。
#
# 两个关键约定(否则必失败):
#   1. prompt 经 STDIN 传入 —— codex 的 -i 是可变参数,会把位置参数 prompt 当图片吞掉。
#   2. 由调用方放到后台运行 —— 图像生成耗时数分钟,前台 120s 会超时被杀。
#
# 用法:
#   generate-frames.sh --prompt <file> --out-dir <dir> [--ref <img>] [--cwd <dir>]
set -euo pipefail

REF=""; OUT_DIR=""; PROMPT_FILE=""; CWD="$(pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --prompt) PROMPT_FILE="$2"; shift 2 ;;
    --cwd) CWD="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 --prompt <file> --out-dir <dir> [--ref <img>] [--cwd <dir>]"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -n "$PROMPT_FILE" ] && [ -n "$OUT_DIR" ] || {
  echo "Usage: $0 --prompt <file> --out-dir <dir> [--ref <img>] [--cwd <dir>]" >&2; exit 1; }
[ -f "$PROMPT_FILE" ] || { echo "prompt file not found: $PROMPT_FILE" >&2; exit 1; }
command -v codex >/dev/null || { echo "codex CLI not found" >&2; exit 1; }

mkdir -p "$OUT_DIR"
args=( -C "$CWD" -s workspace-write --skip-git-repo-check )
[ -n "$REF" ] && args+=( -i "$REF" )

# prompt 走 STDIN(不要作为位置参数)
codex exec "${args[@]}" < "$PROMPT_FILE"
