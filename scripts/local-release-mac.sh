#!/usr/bin/env bash
# 本地复刻 CI desktop-release.yml 的 publish-release 流程（macOS arm64）。
# 用途：CI Actions 预算受限时，在本机签名+公证+发布到 rambocode/cortex-work-release。
#
# 前置：
#   - Developer ID Application 证书已在登录钥匙串（identity: Jiangwei Lan (HQ537XMLJY)）
#   - gh 已登录且对 rambocode/cortex-work-release 有写权限（或设 GH_TOKEN）
#   - 环境变量提供 Apple 公证凭据：
#       APPLE_ID                    Apple 开发者账号邮箱
#       APPLE_APP_SPECIFIC_PASSWORD app 专用密码（appleid.apple.com 生成）
#       APPLE_TEAM_ID               默认 HQ537XMLJY（取自证书）
#
# 用法：
#   export APPLE_ID="..." APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#   bash scripts/local-release-mac.sh            # 发布当前 package.json 版本对应的 tag
set -euo pipefail
cd "$(dirname "$0")/.."

PKG_VERSION="$(node -p "require('./apps/desktop/package.json').version")"
BUILD_TAG="${1:-v$PKG_VERSION}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-HQ537XMLJY}"
REPO="rambocode/cortex-work-release"

# ── 前置校验 ─────────────────────────────────────────────────────────────────
: "${APPLE_ID:?需要 export APPLE_ID}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?需要 export APPLE_APP_SPECIFIC_PASSWORD}"
if [[ "$BUILD_TAG" != "v$PKG_VERSION" ]]; then
  echo "✗ tag($BUILD_TAG) 与 package.json 版本(v$PKG_VERSION) 不一致" >&2; exit 1
fi
if ! security find-identity -v -p codesigning | grep -q "HQ537XMLJY"; then
  echo "✗ 钥匙串未找到 Developer ID 证书(HQ537XMLJY)" >&2; exit 1
fi
GH_TOKEN_VAL="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
: "${GH_TOKEN_VAL:?gh 未登录且未设 GH_TOKEN}"
echo "▶ 发布 ${BUILD_TAG} → ${REPO} (签名+公证)"

# 清掉旧的本地构建产物：dist 里残留的旧版本 dmg/zip 会被后面的 glob 匹配并误传到 release。
# (CI 在干净 VM 上无此问题；本地必须先清。)
rm -rf apps/desktop/dist

# ── 1) 预构建（pi 二进制 + whisper runner + 渲染/主进程 + 提取 release notes）──
CORTEX_NOTES_STRICT=1 pnpm --filter @cortex-work/desktop run prepackage:mac

# ── 2) electron-builder 打包 + 签名 + 公证（不发布；按 electron-builder.yml 的 identity/notarize:true）──
CSC_NAME="Jiangwei Lan (HQ537XMLJY)" \
  pnpm --filter @cortex-work/desktop run build:mac

# ── 3) 校验签名/公证（在仓库外副本上做硬门）──
SRC="apps/desktop/dist"
PRODUCT="$(node -p "require('./apps/desktop/package.json').productName")"
WORK="$(mktemp -d)"
ditto "$SRC/mac-arm64/${PRODUCT}.app" "$WORK/${PRODUCT}.app"
codesign --verify --deep --strict --verbose=2 "$WORK/${PRODUCT}.app"
spctl --assess --type execute --verbose "$WORK/${PRODUCT}.app"
xcrun stapler validate "$WORK/${PRODUCT}.app"
echo "✓ 签名+公证+staple 校验通过"

# ── 4) 发布到 release 仓库（确保 tag ref 存在 → 建 release → 上传产物 + latest-mac.yml）──
export GH_TOKEN="$GH_TOKEN_VAL"
if ! gh api "repos/$REPO/git/ref/tags/$BUILD_TAG" >/dev/null 2>&1; then
  DEF_BRANCH="$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')"
  SHA="$(gh api "repos/$REPO/commits/$DEF_BRANCH" --jq '.sha')"
  gh api --method POST "repos/$REPO/git/refs" -f ref="refs/tags/$BUILD_TAG" -f sha="$SHA" >/dev/null
  echo "✓ 在 $REPO 创建 tag ref $BUILD_TAG"
fi

FILES=(
  "$SRC"/*-arm64.dmg "$SRC"/*-arm64.dmg.blockmap
  "$SRC"/*-arm64-mac.zip "$SRC"/*-arm64-mac.zip.blockmap
  "$SRC/latest-mac.yml"
)
for f in "${FILES[@]}"; do [[ -f "$f" ]] || { echo "✗ 缺产物: $f" >&2; exit 1; }; done
NOTES="apps/desktop/build/release-notes.md"
[[ -f "$NOTES" ]] || { echo "✗ 缺 release notes: $NOTES" >&2; exit 1; }

if ! gh release view "$BUILD_TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$BUILD_TAG" --repo "$REPO" --title "${BUILD_TAG#v}" --notes-file "$NOTES"
fi
gh release upload "$BUILD_TAG" --repo "$REPO" --clobber "${FILES[@]}"
echo "✓ 已发布 $BUILD_TAG 到 https://github.com/$REPO/releases/tag/$BUILD_TAG"
