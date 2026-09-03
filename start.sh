#!/bin/sh
# Bootstrap the bundled Redis, script runner, llm-backend, and nginx.
set -eu

mkdir -p /shared/parsers /shared/parsers/metrics /data /run/redis
touch /shared/parsers/llm-backend.log /shared/parsers/nginx_access.log /shared/parsers/nginx_error.log

export POSTGRES_DB="${POSTGRES_DB:-dawn_course}"
export POSTGRES_USER="${POSTGRES_USER:-dawn}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-dawn}"
export POSTGRES_DATA_DIR="${POSTGRES_DATA_DIR:-/data/postgres}"
export BACKEND_PORT="${PORT:-8080}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export RUNNER_URL="${RUNNER_URL:-http://127.0.0.1:8090}"
export DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}}"
export BACKEND_MIRROR_LOG_FILE="${BACKEND_MIRROR_LOG_FILE:-/shared/parsers/llm-backend.log}"
export SCRIPT_OUTPUT_DIR="${SCRIPT_OUTPUT_DIR:-/shared/parsers}"
export LLM_BACKEND_UPSTREAM="${LLM_BACKEND_UPSTREAM:-127.0.0.1:8080}"
export NGINX_DNS_RESOLVER="${NGINX_DNS_RESOLVER:-127.0.0.11}"

case "$POSTGRES_USER" in
  ""|*[!a-zA-Z0-9_]*)
    echo "[bootstrap] POSTGRES_USER only supports letters, numbers and underscore" >&2
    exit 1
    ;;
esac
case "$POSTGRES_DB" in
  ""|*[!a-zA-Z0-9_]*)
    echo "[bootstrap] POSTGRES_DB only supports letters, numbers and underscore" >&2
    exit 1
    ;;
esac

start_postgres() {
  POSTGRES_PASSWORD_SQL=$(printf "%s" "$POSTGRES_PASSWORD" | sed "s/'/''/g")
  mkdir -p "$POSTGRES_DATA_DIR" /run/postgresql
  chown -R postgres:postgres "$POSTGRES_DATA_DIR" /run/postgresql

  if [ ! -s "$POSTGRES_DATA_DIR/PG_VERSION" ]; then
    su postgres -c "initdb -D '$POSTGRES_DATA_DIR' --encoding=UTF8 --locale=C"
    printf "\nlisten_addresses = '127.0.0.1'\n" >> "$POSTGRES_DATA_DIR/postgresql.conf"
  fi

  su postgres -c "pg_ctl -D '$POSTGRES_DATA_DIR' -o '-c listen_addresses=127.0.0.1' -w start"

  if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${POSTGRES_USER}'\"" | grep -q 1; then
    su postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE ROLE \\\"${POSTGRES_USER}\\\" LOGIN PASSWORD '${POSTGRES_PASSWORD_SQL}'\""
  else
    su postgres -c "psql -v ON_ERROR_STOP=1 -c \"ALTER ROLE \\\"${POSTGRES_USER}\\\" WITH PASSWORD '${POSTGRES_PASSWORD_SQL}'\""
  fi

  if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'\"" | grep -q 1; then
    su postgres -c "createdb -O '${POSTGRES_USER}' '${POSTGRES_DB}'"
  fi
}

start_postgres
redis-server --bind 127.0.0.1 --port 6379 --dir /data --appendonly yes --save 60 1 --daemonize yes

(cd /app/script-runner && PORT=8090 node runner.js) &
RUNNER_PID=$!

(cd /app/llm-backend && PORT="${BACKEND_PORT}" node dist/main.js) &
BACKEND_PID=$!

# Follow only new log lines after startup to avoid replaying old logs on restart.
tail -n 0 -F /shared/parsers/llm-backend.log /shared/parsers/nginx_access.log /shared/parsers/nginx_error.log &
TAIL_PID=$!

READY=0
TRY=0
while [ "$TRY" -lt 60 ]; do
  if wget -q -O - "http://127.0.0.1:${BACKEND_PORT}/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  TRY=$((TRY + 1))
  sleep 1
done

stop_all() {
  kill -TERM "$BACKEND_PID" >/dev/null 2>&1 || true
  kill -TERM "$RUNNER_PID" >/dev/null 2>&1 || true
  kill -TERM "$TAIL_PID" >/dev/null 2>&1 || true
  redis-cli -h 127.0.0.1 -p 6379 shutdown >/dev/null 2>&1 || true
  su postgres -c "pg_ctl -D '$POSTGRES_DATA_DIR' -m fast -w stop" >/dev/null 2>&1 || true
}

if [ "$READY" -ne 1 ]; then
  echo "[bootstrap] llm-backend health check failed" >&2
  stop_all
  exit 1
fi

trap stop_all TERM INT

# 无 TLS 部署下，客户端只能走 nginx 的静态 /scripts/<category>/<name>.js 下载路径，
# 并按「实际下发的原始字节」验签同名 .meta.json。这里对 nginx try_files 真正会命中的
# 目录重新生成边车，保证持久卷里被 LLM 修复 / 管理端上传覆盖过的脚本也有匹配的签名。
# 私钥缺失时只告警不阻塞启动（此时客户端继续用 assets 兜底）。
if [ -f /app/scripts/gen-script-meta.mjs ]; then
  if node /app/scripts/gen-script-meta.mjs --fill-stale --quiet \
       --root /usr/share/nginx/html/scripts/js \
       --root /usr/share/nginx/html/scripts/parsers \
       --root /usr/share/nginx/html/scripts/runtime \
       --root "${SCRIPT_OUTPUT_DIR}"; then
    echo "[bootstrap] script meta sidecars refreshed"
  else
    echo "[bootstrap] WARN: script meta generation skipped (signing key unavailable?)" >&2
  fi
fi

sed \
  -e "s#__LLM_BACKEND_UPSTREAM__#${LLM_BACKEND_UPSTREAM}#g" \
  -e "s#__NGINX_DNS_RESOLVER__#${NGINX_DNS_RESOLVER}#g" \
  /etc/nginx/nginx.conf > /tmp/nginx.conf
nginx -t -c /tmp/nginx.conf
nginx -g "daemon off;" -c /tmp/nginx.conf &
NGINX_PID=$!

while true; do
  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "[bootstrap] llm-backend exited" >&2
    kill -TERM "$NGINX_PID" >/dev/null 2>&1 || true
    stop_all
    exit 1
  fi
  if ! kill -0 "$RUNNER_PID" >/dev/null 2>&1; then
    echo "[bootstrap] script-runner exited" >&2
    kill -TERM "$NGINX_PID" >/dev/null 2>&1 || true
    stop_all
    exit 1
  fi
  if ! kill -0 "$NGINX_PID" >/dev/null 2>&1; then
    wait "$NGINX_PID"
    break
  fi
  sleep 2
done
