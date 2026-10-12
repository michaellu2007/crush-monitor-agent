@echo off
cd /d D:\crush-monitor-1.2.0
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
pause
