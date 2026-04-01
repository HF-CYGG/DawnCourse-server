@echo off
setlocal
cd /d "%~dp0llm-backend"
set "ADMIN_WEB_ROOT=..\html"
set "PORT=8080"
set "ADMIN_LOCAL_MODE=true"
set "REDIS_URL="
if not exist "node_modules\redis" (
  npm install
)
start "" "http://localhost:8080/admin/"
node server.js
