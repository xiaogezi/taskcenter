#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.local/runtime"
LOG_DIR="$PROJECT_DIR/.local/logs"
PID_FILE="$RUNTIME_DIR/web.pid"
LOCK_DIR="$RUNTIME_DIR/launcher.lock"
LOG_FILE="$LOG_DIR/web.log"
URL="http://localhost:3000"
HEALTH_URL="http://127.0.0.1:3001/health"
ACTION="${1:-status}"
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$RUNTIME_DIR" "$LOG_DIR"

health_check() {
    curl --silent --fail --max-time 2 "$HEALTH_URL" >/dev/null 2>&1 \
        && curl --silent --fail --max-time 2 "$URL" >/dev/null 2>&1
}

read_pid() {
    if [[ -f "$PID_FILE" ]]; then
        tr -dc '0-9' < "$PID_FILE"
    fi
}

is_project_process() {
    local pid="$1"
    local command
    local cwd
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    [[ "$cwd" == "$PROJECT_DIR" && "$command" == *"scripts/dev-live.mjs"* ]]
}

acquire_lock() {
    local attempts=0
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
        attempts=$((attempts + 1))
        if [[ "$attempts" -ge 50 ]]; then
            echo "另一个 TaskCenter 启停操作正在执行，请稍后重试。"
            exit 1
        fi
        sleep 0.1
    done
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}

open_dashboard() {
    if [[ "${TASKCENTER_NO_OPEN:-0}" == "1" ]]; then
        return
    fi
    /usr/bin/osascript \
        "$PROJECT_DIR/scripts/macos/open-taskcenter.applescript" \
        "$URL" >/dev/null 2>&1 || /usr/bin/open "$URL"
}

rotate_log() {
    local size=0
    if [[ -f "$LOG_FILE" ]]; then
        size="$(stat -f '%z' "$LOG_FILE" 2>/dev/null || echo 0)"
    fi
    if [[ "$size" -gt 10485760 ]]; then
        mv "$LOG_FILE" "$LOG_FILE.1"
    fi
}

find_node() {
    local candidate
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
        if [[ -x "$candidate" ]]; then
            echo "$candidate"
            return
        fi
    done
    command -v node 2>/dev/null || true
}

start_service() {
    local node
    local pid
    if health_check; then
        open_dashboard
        echo "TaskCenter 已在运行，已打开现有页面。"
        return
    fi

    pid="$(read_pid)"
    if [[ -n "$pid" ]] && ! is_project_process "$pid"; then
        rm -f "$PID_FILE"
    fi
    if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 \
        || lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
        echo "启动失败：3000 或 3001 端口已被其他程序占用。"
        exit 1
    fi
    if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
        echo "启动失败：项目依赖未安装，请先在 TaskCenter 目录运行 npm install。"
        exit 1
    fi
    node="$(find_node)"
    if [[ -z "$node" ]]; then
        echo "启动失败：没有找到 Node.js。"
        exit 1
    fi

    rotate_log
    (
        cd "$PROJECT_DIR"
        "$node" scripts/taskcenter-detached-launch.mjs
    )

    for _ in {1..40}; do
        if health_check; then
            open_dashboard
            echo "TaskCenter 启动成功：http://localhost:3000"
            return
        fi
        sleep 0.5
    done

    pid="$(read_pid)"
    if [[ -n "$pid" ]] && is_project_process "$pid"; then
        kill -TERM "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "TaskCenter 启动失败，请查看日志：$LOG_FILE"
    exit 1
}

stop_service() {
    local pid
    pid="$(read_pid)"
    if [[ -z "$pid" ]]; then
        if health_check; then
            echo "当前服务不是由 TaskCenter 桌面入口管理，未停止未知进程。"
            exit 1
        fi
        echo "TaskCenter 当前没有运行。"
        return
    fi
    if ! is_project_process "$pid"; then
        rm -f "$PID_FILE"
        echo "PID 校验失败，未操作未知进程。"
        exit 1
    fi

    kill -TERM "$pid"
    for _ in {1..30}; do
        if ! kill -0 "$pid" 2>/dev/null; then
            rm -f "$PID_FILE"
            echo "TaskCenter 已安全停止。"
            return
        fi
        sleep 0.2
    done
    echo "停止超时，未强制结束进程。"
    exit 1
}

status_service() {
    if health_check; then
        echo "运行中：http://localhost:3000"
    else
        echo "未运行"
        exit 1
    fi
}

acquire_lock
case "$ACTION" in
    start) start_service ;;
    stop) stop_service ;;
    restart)
        stop_service
        sleep 0.5
        start_service
        ;;
    status) status_service ;;
    *)
        echo "用法：$0 {start|stop|restart|status}"
        exit 2
        ;;
esac
