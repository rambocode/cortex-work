#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
CHECK_ONLY=0

case "${1:-}" in
  --check)
    CHECK_ONLY=1
    ;;
  "" )
    ;;
  * )
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

required_vars=(
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
)

missing=()
for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "Missing required signing/notarization values: ${missing[*]}" >&2
  echo "Fill $ENV_FILE locally, or provide them as CI environment variables." >&2
  exit 1
fi

export CSC_NAME="${CSC_NAME:-Jiangwei Lan (HQ537XMLJY)}"

if ! grep -qE '^[[:space:]]+notarize:' "$ROOT_DIR/apps/desktop/electron-builder.yml"; then
  echo "Warning: apps/desktop/electron-builder.yml has no mac.notarize config." >&2
  echo "The DMG may be signed but not notarized until that config is added." >&2
fi

if (( CHECK_ONLY == 1 )); then
  echo "DMG packaging environment looks usable."
  echo "CSC_NAME=$CSC_NAME"
  exit 0
fi

cd "$ROOT_DIR"
rm -rf apps/desktop/dist/mac-arm64
pnpm --filter @cortex-work/desktop dist:dmg
