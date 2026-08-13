#!/bin/bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "此脚本只支持 macOS。" >&2
    exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE_TEMPLATE="$PROJECT_DIR/scripts/macos/taskcenter-app.applescript"
APP_PATH="${TASKCENTER_APP_PATH:-$HOME/Desktop/任务中心 TaskCenter.app}"
TEMP_DIR="$(mktemp -d)"
TEMP_SOURCE="$TEMP_DIR/taskcenter-app.applescript"
TEMP_APP="$TEMP_DIR/任务中心 TaskCenter.app"

trap 'rm -rf "$TEMP_DIR"' EXIT

if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
    echo "项目依赖尚未安装，请先运行 npm install。" >&2
    exit 1
fi

for command in osacompile plutil codesign; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "缺少 macOS 工具：$command" >&2
        exit 1
    fi
done

/usr/bin/sed "s|__TASKCENTER_PROJECT_DIR__|$PROJECT_DIR|g" \
    "$SOURCE_TEMPLATE" >"$TEMP_SOURCE"
/usr/bin/osacompile -o "$TEMP_APP" "$TEMP_SOURCE"
PLIST="$TEMP_APP/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleIdentifier -string "com.taskcenter.desktop" "$PLIST"
/usr/bin/plutil -replace CFBundleName -string "任务中心 TaskCenter" "$PLIST"
/usr/bin/plutil -replace OSAAppletStayOpen -bool false "$PLIST"
/usr/bin/plutil -replace LSUIElement -bool true "$PLIST"
/usr/bin/codesign --force --deep --sign - "$TEMP_APP"

if [[ -e "$APP_PATH" ]]; then
    mv "$APP_PATH" "$HOME/.Trash/任务中心-TaskCenter-旧版-$(date +%Y%m%d-%H%M%S).app"
fi
mv "$TEMP_APP" "$APP_PATH"

echo "已生成桌面启动入口：$APP_PATH"
