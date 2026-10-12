@echo off
rem 切到本 bat 所在目录，克隆到任何路径都能直接双击运行
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm ci || (echo npm ci failed & pause & exit /b 1)
)
if not exist dist\index.html (
  echo Building, please wait...
  call npm run build || (echo build failed & pause & exit /b 1)
)
title crush-monitor
call npm start
if errorlevel 1 pause
