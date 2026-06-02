@echo off
REM Wiretap sidecar - double-click to start the local terminal bridge. Close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required but was not found on PATH. & pause & exit /b 1)
if not exist "node_modules" ( echo Installing dependencies... & call npm install )
echo Starting Wiretap sidecar...  ^(close this window to stop^)
call npm run server:start
pause
