@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not available in Command Prompt.
  echo Install Node.js 22.13.0 or newer, restart Windows, and try again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not installed or is not available in Command Prompt.
  echo Reinstall Node.js 22.13.0 or newer, restart Windows, and try again.
  pause
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)"
if errorlevel 1 (
  echo This project requires Node.js 22.13.0 or newer.
  echo Installed version:
  node --version
  pause
  exit /b 1
)

if /i "%NODE_OPTIONS%"=="--openssl-legacy-provider" (
  echo Ignoring the obsolete NODE_OPTIONS=--openssl-legacy-provider workaround.
  set "NODE_OPTIONS="
)

echo Installing the project's locked dependencies...
call npm ci
if errorlevel 1 (
  echo.
  echo Installation failed. Review the npm error above.
  pause
  exit /b 1
)

if /i "%~1"=="--install-only" exit /b 0

echo.
echo Starting My Cafe Gourmand at http://localhost:3000 ...
call npm run dev
