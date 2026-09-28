@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 18 or newer first.
  pause
  exit /b 1
)
set PORT=8787
start "" http://localhost:8787
node server.js
pause
