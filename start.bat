@echo off
setlocal
cd /d "%~dp0llm-backend"
set "ADMIN_WEB_ROOT=..\html"
set "PORT=8080"
set "ADMIN_LOCAL_MODE=true"
set "REDIS_URL="
set "MAX_PORT_TRY=10"
set "TRY_INDEX=0"
:find_port
set /a TRY_INDEX+=1
for /f "tokens=1" %%A in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do set "PORT_USED=1"
if defined PORT_USED (
  set "PORT_USED="
  set /a PORT+=1
  if %TRY_INDEX% LSS %MAX_PORT_TRY% goto find_port
)
if not exist "node_modules\redis" (
  npm install
)
start "" "http://localhost:%PORT%/admin/"
node server.js
