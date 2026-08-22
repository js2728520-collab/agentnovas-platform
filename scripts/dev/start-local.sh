#!/usr/bin/env bash
# 本地启动三端开发服务。
#
# 三端必须各自用对应的数据库角色：应用会校验「连接串角色 == RIVERTON_APP_AUDIENCE」
# （lib/postgres.ts），迁移 0040/0043 的 RLS 策略也按 current_user 判定。
# 用超级用户连是跑不起来的——这是好事，本地跑的就是生产那套角色与 RLS 边界。
#
# 端口默认 3010/3011/3012，避开常被占用的 3000-3002。RIVERTON_APP_LOCAL_PORT
# 必须与实际端口一致，否则 audience 解析返回 UNKNOWN_AUDIENCE。
#
# 用法：
#   bash scripts/dev/start-local.sh          启动
#   bash scripts/dev/start-local.sh stop     停止
#
# 前置（只需一次）：
#   createdb agentnovas_dev
#   npm run postgres:migrate
#   ALLOW_LOCAL_DEV_BOOTSTRAP=1 node --env-file-if-exists=.env.local \
#     --experimental-strip-types scripts/dev/provision-local-roles.mjs
#   ALLOW_LOCAL_DEV_BOOTSTRAP=1 node --env-file-if-exists=.env.local \
#     --experimental-strip-types scripts/dev/bootstrap-local-admin.mjs <邮箱> <密码>

set -euo pipefail
cd "$(dirname "$0")/../.."

LOG_DIR="${RIVERTON_DEV_LOG_DIR:-/tmp/rv-dev}"
DB_NAME="${RIVERTON_DEV_DB:-agentnovas_dev}"
DB_PASSWORD="${LOCAL_DB_ROLE_PASSWORD:-localdev}"
mkdir -p "$LOG_DIR"

stop_all() {
  for port in 3010 3011 3012; do
    for pid in $(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
      kill -9 "$pid" 2>/dev/null && echo "已停止 :$port (pid $pid)" || true
    done
  done
}

if [[ "${1:-}" == "stop" ]]; then
  stop_all
  exit 0
fi

stop_all
sleep 1

start_one() {
  local audience="$1" port="$2" role="$3"
  # 注意 ${role} 的大括号：zsh 会把 $role:l 当成参数展开修饰符（小写化），
  # 于是 "$role:localdev" 被解析成 "<lowercased role>ocaldev"，连接串静默损坏。
  (
    set -a
    # shellcheck disable=SC1091
    [[ -f .env.local ]] && . ./.env.local
    set +a
    export DATABASE_URL="postgresql://${role}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}"
    export RIVERTON_APP_AUDIENCE="$audience"
    export RIVERTON_APP_LOCAL_PORT="$port"
    export NODE_USE_ENV_PROXY=1
    nohup npx next dev -p "$port" > "$LOG_DIR/$audience.log" 2>&1 &
  )
  echo "启动 $audience → http://localhost:$port  (日志 $LOG_DIR/$audience.log)"
}

start_one client      3010 agentnovas_client_web
start_one operations  3011 agentnovas_ops_web
start_one maintenance 3012 agentnovas_maint_web

echo
echo "等待就绪…"
sleep 25
for entry in 3010:client 3011:operations 3012:maintenance; do
  port="${entry%%:*}"; name="${entry##*:}"
  status=$(curl -s --max-time 30 "http://localhost:$port/api/health/ready" || echo '{"status":"unreachable"}')
  printf "  %-12s %s\n" "$name" "$status"
done
