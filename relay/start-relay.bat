@echo off
setlocal
title Relay
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Relay] Node.js not found. Install Node.js 22.13 or newer from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [Relay] Installing dependencies...
  call npm.cmd ci
  if errorlevel 1 goto :failed
)

if not exist "dist\index.html" (
  echo [Relay] Building web app...
  call npm.cmd run build
  if errorlevel 1 goto :failed
)

set "PORT=4782"
if defined RELAY_PORT set "PORT=%RELAY_PORT%"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="RELAY_PORT" set "PORT=%%B"

echo [Relay] Starting at http://127.0.0.1:%PORT%  (close this window or press Ctrl+C to stop)
if not defined RELAY_NO_BROWSER start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"
call npm.cmd start
echo [Relay] Server stopped.
pause
exit /b 0

:failed
echo [Relay] Setup failed. See the messages above.
pause
exit /b 1
