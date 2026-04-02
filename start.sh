#!/bin/sh
set -eu

mkdir -p /shared/parsers /data /run/redis
touch /shared/parsers/llm-backend.log /shared/parsers/nginx_access.log /shared/parsers/nginx_error.log

redis-server --bind 127.0.0.1 --port 6379 --dir /data --appendonly yes --save 60 1 --daemonize yes

export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export BACKEND_MIRROR_LOG_FILE="${BACKEND_MIRROR_LOG_FILE:-/shared/parsers/llm-backend.log}"
export SCRIPT_OUTPUT_DIR="${SCRIPT_OUTPUT_DIR:-/shared/parsers}"

node /app/llm-backend/server.js &
BACKEND_PID=$!

tail -n +1 -F /shared/parsers/llm-backend.log /shared/parsers/nginx_access.log /shared/parsers/nginx_error.log &
TAIL_PID=$!

term_handler() {
  kill -TERM "$BACKEND_PID" >/dev/null 2>&1 || true
  kill -TERM "$TAIL_PID" >/dev/null 2>&1 || true
  redis-cli -h 127.0.0.1 -p 6379 shutdown >/dev/null 2>&1 || true
}

trap term_handler TERM INT

nginx -t
nginx -g "daemon off;" &
NGINX_PID=$!

wait "$NGINX_PID"
