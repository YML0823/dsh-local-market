@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  未找到 Node.js。请先安装 Node.js 20 或更新版本。
  echo  https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo  DSH 插件市场正在启动...
echo  浏览器会自动打开 http://127.0.0.1:7788
echo  关闭此窗口即可停止服务。
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:7788'"
node server.js

if errorlevel 1 pause
