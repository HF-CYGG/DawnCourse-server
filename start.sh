#!/bin/sh
set -eu

mkdir -p /shared/parsers /data /run/redis
touch /shared/parsers/llm-backend.log /shared/parsers/nginx_access.log /shared/parsers/nginx_error.log

redis-server --bind 127.0.0.1 --port 6379 --dir /data --appendonly yes --save 60 1 --daemonize yes

export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export BACKEND_MIRROR_LOG_FILE="${BACKEND_MIRROR_LOG_FILE:-/shared/parsers/llm-backend.log}"
export SCRIPT_OUTPUT_DIR="${SCRIPT_OUTPUT_DIR:-/shared/parsers}"
export LLM_BACKEND_UPSTREAM="${LLM_BACKEND_UPSTREAM:-127.0.0.1:8080}"

node /app/llm-backend/server.js &
BACKEND_PID=$!

tail -n +1 -F /shared/parsers/llm-backend.log /shared/parsers/nginx_access.log /shared/parsers/nginx_error.log &
TAIL_PID=$!

READY=0
TRY=0
while [ "$TRY" -lt 30 ]; do
  if wget -q -O - http://127.0.0.1:8080/health >/dev/null 2>&1; then
    READY=1
    break
  fi
  TRY=$((TRY + 1))
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "[bootstrap] llm-backend health check failed" >&2
  kill -TERM "$BACKEND_PID" >/dev/null 2>&1 || true
  kill -TERM "$TAIL_PID" >/dev/null 2>&1 || true
  redis-cli -h 127.0.0.1 -p 6379 shutdown >/dev/null 2>&1 || true
  exit 1
fi

term_handler() {
  kill -TERM "$BACKEND_PID" >/dev/null 2>&1 || true
  kill -TERM "$TAIL_PID" >/dev/null 2>&1 || true
  redis-cli -h 127.0.0.1 -p 6379 shutdown >/dev/null 2>&1 || true
}

trap term_handler TERM INT

sed "s#__LLM_BACKEND_UPSTREAM__#${LLM_BACKEND_UPSTREAM}#g" /etc/nginx/nginx.conf > /tmp/nginx.conf
nginx -t -c /tmp/nginx.conf
nginx -g "daemon off;" -c /tmp/nginx.conf &
NGINX_PID=$!

while true; do
  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "[bootstrap] llm-backend exited" >&2
    kill -TERM "$NGINX_PID" >/dev/null 2>&1 || true
    kill -TERM "$TAIL_PID" >/dev/null 2>&1 || true
    redis-cli -h 127.0.0.1 -p 6379 shutdown >/dev/null 2>&1 || true
    exit 1
  fi
  if ! kill -0 "$NGINX_PID" >/dev/null 2>&1; then
    wait "$NGINX_PID"
    break
  fi
  sleep 2
done
