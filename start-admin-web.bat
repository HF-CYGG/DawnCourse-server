@echo off
setlocal
cd /d "%~dp0llm-backend"
set "ADMIN_WEB_ROOT=..\html"
set "PORT=8080"
set "REDIS_URL=redis://localhost:6379"
node server.js
