@echo off
setlocal EnableExtensions DisableDelayedExpansion
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

set "RELAY_CODEX_BIN_CONFIGURED="
if exist ".env" for /f "usebackq tokens=1 delims==" %%A in (".env") do if /i "%%A"=="RELAY_CODEX_BIN" set "RELAY_CODEX_BIN_CONFIGURED=1"
if not defined RELAY_CODEX_BIN if not defined RELAY_CODEX_BIN_CONFIGURED (
  for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "(Get-AppxPackage -Name OpenAI.Codex).InstallLocation"`) do (
    if exist "%%I\app\resources\codex.exe" set "RELAY_CODEX_BIN=%%I\app\resources\codex.exe"
  )
)

set "PORT=4782"
if defined RELAY_PORT set "PORT=%RELAY_PORT%"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="RELAY_PORT" set "PORT=%%B"

set "RELAY_SUPERVISED=1"
set "RELAY_RESTART_MARKER=%TEMP%\relay-restart-%RANDOM%-%RANDOM%.flag"
if exist "%RELAY_RESTART_MARKER%\." goto :marker_failed
if exist "%RELAY_RESTART_MARKER%" del /f /q "%RELAY_RESTART_MARKER%"
if exist "%RELAY_RESTART_MARKER%" goto :marker_failed

echo [Relay] Starting at http://127.0.0.1:%PORT%  (close this window or press Ctrl+C to stop)
if not "%RELAY_NO_BROWSER%"=="1" start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"

:run
call npm.cmd start
set "RELAY_EXIT_CODE=%errorlevel%"
if not exist "%RELAY_RESTART_MARKER%" goto :stopped
if exist "%RELAY_RESTART_MARKER%\." goto :marker_failed
del /f /q "%RELAY_RESTART_MARKER%"
if exist "%RELAY_RESTART_MARKER%" goto :marker_failed
echo [Relay] Restarting Relay...
set "RELAY_NO_BROWSER=1"
goto :run

:marker_failed
echo [Relay] Could not clear restart marker "%RELAY_RESTART_MARKER%".
set "RELAY_EXIT_CODE=1"

:stopped
if "%RELAY_EXIT_CODE%"=="0" (
  echo [Relay] Server stopped.
) else (
  echo [Relay] Server stopped ^(exit code %RELAY_EXIT_CODE%^).
)
pause
exit /b %RELAY_EXIT_CODE%

:failed
echo [Relay] Setup failed. See the messages above.
pause
exit /b 1
