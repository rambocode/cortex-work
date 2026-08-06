#!/usr/bin/env bash
# 本地复刻 CI desktop-release.yml 的 publish-release 流程（macOS arm64 + x64 双架构）。
# 用途：CI Actions 预算受限时，在本机签名+公证+发布到 rambocode/cortex-work-release。
#
# 两个架构仍串行跑（不并行/不合并成一条 electron-builder 命令）：本脚本与 release:ui 的
# 阶段编排、断点续跑状态机都按串行设计（原先「resources/pi/ 单一共享目录」的理由已随
# pi gateway 化删除而消失，是否可并行需单独评估，不要顺手放开）。
# 发布只在最后做一次：合并两份 latest-mac.yml 后一次性上传，避免出现"一个架构的上传把
# 另一个架构覆盖"的问题（这正是 v0.1.27 发布事故的根源；这半条与 pi 无关，任何时候都不得放开）。
#
# 前置：
#   - Developer ID Application 证书已在登录钥匙串（identity: Jiangwei Lan (HQ537XMLJY)）
#   - gh 已登录且对 rambocode/cortex-work-release 有写权限（或设 GH_TOKEN）
#   - 环境变量提供 Apple 公证凭据：
#       APPLE_KEYCHAIN_PROFILE      推荐：notarytool 存入钥匙串的 profile 名称
#     或：
#       APPLE_ID                    Apple 开发者账号邮箱
#       APPLE_APP_SPECIFIC_PASSWORD app 专用密码（appleid.apple.com 生成）
#       APPLE_TEAM_ID               默认 HQ537XMLJY（取自证书）
#
# 用法：
#   xcrun notarytool store-credentials "cortex-release" --apple-id "..." --team-id HQ537XMLJY
#   APPLE_KEYCHAIN_PROFILE="cortex-release" bash scripts/local-release-mac.sh
#   # 或使用环境变量：
#   export APPLE_ID="..." APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#   bash scripts/local-release-mac.sh            # 发布当前 package.json 版本对应的 tag
#
# Windows x64 产物走 scripts/local-release-win.sh（假定本脚本已先发布、tag 已存在）。
set -euo pipefail
cd "$(dirname "$0")/.."

PKG_VERSION="$(node -p "require('./apps/desktop/package.json').version")"
BUILD_TAG="${1:-v$PKG_VERSION}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-HQ537XMLJY}"
REPO="rambocode/cortex-work-release"
PRODUCT="$(node -p "require('./apps/desktop/package.json').productName")"

# ── 前置校验 ─────────────────────────────────────────────────────────────────
if [[ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  : "${APPLE_ID:?需要 export APPLE_ID，或设置 APPLE_KEYCHAIN_PROFILE}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?需要 export APPLE_APP_SPECIFIC_PASSWORD，或设置 APPLE_KEYCHAIN_PROFILE}"
fi
if [[ "$BUILD_TAG" != "v$PKG_VERSION" ]]; then
  echo "✗ tag($BUILD_TAG) 与 package.json 版本(v$PKG_VERSION) 不一致" >&2; exit 1
fi
if ! security find-identity -v -p codesigning | grep -q "HQ537XMLJY"; then
  echo "✗ 钥匙串未找到 Developer ID 证书(HQ537XMLJY)" >&2; exit 1
fi
GH_TOKEN_VAL="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
: "${GH_TOKEN_VAL:?gh 未登录且未设 GH_TOKEN}"
echo "▶ 发布 ${BUILD_TAG} → ${REPO} (macOS arm64 + x64,签名+公证)"

# 清掉旧的本地构建产物：dist 里残留的旧版本 dmg/zip 会被后面的 glob 匹配并误传到 release。
# (CI 在干净 VM 上无此问题；本地必须先清一次。)
rm -rf apps/desktop/dist
STAGE="$(mktemp -d)"
echo "暂存目录: $STAGE"

verify_signed_app() {
  local app_dir="$1" dmg_glob="$2"
  local work="$(mktemp -d)"
  ditto "$app_dir/${PRODUCT}.app" "$work/${PRODUCT}.app"
  codesign --verify --deep --strict --verbose=2 "$work/${PRODUCT}.app"
  spctl --assess --type execute --verbose "$work/${PRODUCT}.app"
  xcrun stapler validate "$work/${PRODUCT}.app"
  local dmg
  dmg="$(ls -1 $dmg_glob | head -n 1)"
  cp "$dmg" "$work/"
  local dmg_copy="$work/$(basename "$dmg")"
  spctl --assess --type open --context context:primary-signature --verbose "$dmg_copy" \
    || echo "DMG 无独立代码签名/公证 — 可接受(挂载后 app 已公证,Gatekeeper 认 app)。"
  xcrun stapler validate "$dmg_copy" \
    || echo "DMG 无 stapled ticket — 可接受(app ticket 已 staple)。"
  echo "✓ 签名+公证+staple 校验通过($app_dir)"
}

# ── channel arm64 ────────────────────────────────────────────────────────────
echo "── channel: macOS arm64 ──"
CORTEX_NOTES_STRICT=1 pnpm --filter @cortex-work/desktop run prepackage:mac-arm64
CSC_NAME="Jiangwei Lan (HQ537XMLJY)" pnpm --filter @cortex-work/desktop run build:mac-arm64
verify_signed_app "apps/desktop/dist/mac-arm64" "apps/desktop/dist/*-arm64.dmg"
# pi 打包态护栏(0.1.54 教训:护栏不在发布链上=没有护栏):依赖闭包比对 asar + asar 内真实加载 +
# worker 真 fork。脚本自带仓库外隔离;只跑 arm64(失败类型为 JS 模块解析,与架构无关)。
node apps/desktop/scripts/verify-pi-ai-packaging.mjs "apps/desktop/dist/mac-arm64/${PRODUCT}.app"
cp apps/desktop/dist/*-arm64.dmg apps/desktop/dist/*-arm64.dmg.blockmap "$STAGE/"
cp apps/desktop/dist/*-arm64.zip apps/desktop/dist/*-arm64.zip.blockmap "$STAGE/"
cp apps/desktop/dist/latest-mac.yml "$STAGE/latest-mac-arm64.yml"
cp -r apps/desktop/build "$STAGE/build" # release-notes.md 供后面发布用

# ── channel x64（x64 的 prepackage 会重写 dist/ 与构建产物，必须在 arm64 产物已拷进 STAGE 之后再跑）──
echo "── channel: macOS x64 ──"
pnpm --filter @cortex-work/desktop run prepackage:mac-x64
CSC_NAME="Jiangwei Lan (HQ537XMLJY)" pnpm --filter @cortex-work/desktop run build:mac-x64
verify_signed_app "apps/desktop/dist/mac" "apps/desktop/dist/*-x64.dmg"
cp apps/desktop/dist/*-x64.dmg apps/desktop/dist/*-x64.dmg.blockmap "$STAGE/"
cp apps/desktop/dist/*-x64.zip apps/desktop/dist/*-x64.zip.blockmap "$STAGE/"
cp apps/desktop/dist/latest-mac.yml "$STAGE/latest-mac-x64.yml"

# ── 合并清单 + 双重护栏 ──────────────────────────────────────────────────────
node apps/desktop/scripts/merge-mac-update-manifest.mjs \
  --arm64 "$STAGE/latest-mac-arm64.yml" \
  --x64 "$STAGE/latest-mac-x64.yml" \
  --out "$STAGE/latest-mac.yml"
node apps/desktop/scripts/merge-mac-update-manifest.mjs --verify "$STAGE/latest-mac.yml"
# per-arch 中间清单绝不上传，合并后即删除，杜绝"误传单架构清单"的可能。
rm -f "$STAGE/latest-mac-arm64.yml" "$STAGE/latest-mac-x64.yml"

# ── 发布到 release 仓库（确保 tag ref 存在 → 建 release → 一次性上传全部产物）──
export GH_TOKEN="$GH_TOKEN_VAL"
if ! gh api "repos/$REPO/git/ref/tags/$BUILD_TAG" >/dev/null 2>&1; then
  DEF_BRANCH="$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')"
  SHA="$(gh api "repos/$REPO/commits/$DEF_BRANCH" --jq '.sha')"
  gh api --method POST "repos/$REPO/git/refs" -f ref="refs/tags/$BUILD_TAG" -f sha="$SHA" >/dev/null
  echo "✓ 在 $REPO 创建 tag ref $BUILD_TAG"
fi

NOTES="$STAGE/build/release-notes.md"
[[ -f "$NOTES" ]] || { echo "✗ 缺 release notes: $NOTES" >&2; exit 1; }

for pattern in "*-arm64.dmg" "*-arm64.zip" "*-x64.dmg" "*-x64.zip" "latest-mac.yml"; do
  ls "$STAGE"/$pattern >/dev/null 2>&1 || { echo "✗ 缺产物: $pattern" >&2; exit 1; }
done

if ! gh release view "$BUILD_TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$BUILD_TAG" --repo "$REPO" --title "${BUILD_TAG#v}" --notes-file "$NOTES"
fi
gh release upload "$BUILD_TAG" --repo "$REPO" --clobber "$STAGE"/*.dmg "$STAGE"/*.dmg.blockmap \
  "$STAGE"/*.zip "$STAGE"/*.zip.blockmap "$STAGE/latest-mac.yml"
echo "✓ 已发布 ${BUILD_TAG}(macOS arm64 + x64)到 https://github.com/$REPO/releases/tag/$BUILD_TAG"
