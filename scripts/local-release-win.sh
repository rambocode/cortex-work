#!/usr/bin/env bash
# 本地构建 Windows x64 产物，追加上传到已存在的 release（假定 scripts/local-release-mac.sh
# 已先发布同一个 tag，release 与 tag ref 均已存在）。
#
# 不签名（CSC_IDENTITY_AUTO_DISCOVERY=false，现状不变），故无需 Apple 相关凭据。
# 独立成单独脚本而非塞进 local-release-mac.sh 的编排：在 macOS 上交叉打 Windows 包依赖
# electron-builder 自带的 NSIS/rcedit 工具链，属于不同风险面，出问题时不应阻塞 mac 双架构发布。
#
# 用法：
#   bash scripts/local-release-win.sh            # 追加发布当前 package.json 版本对应的 tag
set -euo pipefail
shopt -s nullglob # 下方产物护栏用数组长度判断 pattern 是否命中,依赖未匹配的 glob 展开为空
cd "$(dirname "$0")/.."

PKG_VERSION="$(node -p "require('./apps/desktop/package.json').version")"
BUILD_TAG="${1:-v$PKG_VERSION}"
REPO="rambocode/cortex-work-release"

if [[ "$BUILD_TAG" != "v$PKG_VERSION" ]]; then
  echo "✗ tag($BUILD_TAG) 与 package.json 版本(v$PKG_VERSION) 不一致" >&2; exit 1
fi
GH_TOKEN_VAL="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
: "${GH_TOKEN_VAL:?gh 未登录且未设 GH_TOKEN}"
if ! gh release view "$BUILD_TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "✗ release $BUILD_TAG 在 $REPO 尚不存在，请先跑 scripts/local-release-mac.sh 发布 mac 双架构" >&2
  exit 1
fi
echo "▶ 追加发布 ${BUILD_TAG} → ${REPO} (Windows x64,未签名)"

rm -rf apps/desktop/dist
pnpm --filter @cortex-work/desktop run prepackage:win-x64
pnpm --filter @cortex-work/desktop run build:win-x64

SRC="apps/desktop/dist"
# 必须存在的产物(nullglob 下未匹配的 pattern 展开为空数组,用长度判断而非 ls 是否成功——
# ls "$SRC"/ 本身在目录存在时总会成功,不能反映某个 pattern 是否真的匹配到文件)。
# win 只出 nsis .exe(zip 目标已从 electron-builder.yml 移除,不再生成/发布)。
for pattern in "*.exe" "latest.yml"; do
  matches=("$SRC"/$pattern)
  [[ ${#matches[@]} -gt 0 ]] || { echo "✗ 缺产物: $pattern" >&2; exit 1; }
done

export GH_TOKEN="$GH_TOKEN_VAL"
gh release upload "$BUILD_TAG" --repo "$REPO" --clobber \
  "$SRC"/*.exe "$SRC"/*.exe.blockmap "$SRC/latest.yml"
echo "✓ 已追加发布 ${BUILD_TAG} 的 Windows x64 产物到 https://github.com/$REPO/releases/tag/$BUILD_TAG"
