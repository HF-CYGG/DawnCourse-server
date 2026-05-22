#!/bin/sh
# Bootstrap the bundled Redis, script runner, llm-backend, and nginx.
set -eu

mkdir -p /shared/parsers /shared/parsers/metrics /data /run/redis
touch /shared/parsers/llm-backend.log /shared/parsers/nginx_access.log /shared/parsers/nginx_error.log

redis-server --bind 127.0.0.1 --port 6379 --dir /data --appendonly yes --save 60 1 --daemonize yes

export BACKEND_PORT="${PORT:-8080}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export RUNNER_URL="${RUNNER_URL:-http://127.0.0.1:8090}"
export DATABASE_URL="${DATABASE_URL:-postgres://dawn:${POSTGRES_PASSWORD:-dawn}@postgres:5432/dawn_course}"
export BACKEND_MIRROR_LOG_FILE="${BACKEND_MIRROR_LOG_FILE:-/shared/parsers/llm-backend.log}"
export SCRIPT_OUTPUT_DIR="${SCRIPT_OUTPUT_DIR:-/shared/parsers}"
export LLM_BACKEND_UPSTREAM="${LLM_BACKEND_UPSTREAM:-127.0.0.1:8080}"
export NGINX_DNS_RESOLVER="${NGINX_DNS_RESOLVER:-127.0.0.11}"

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
}

if [ "$READY" -ne 1 ]; then
  echo "[bootstrap] llm-backend health check failed" >&2
  stop_all
  exit 1
fi

trap stop_all TERM INT

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
