@echo off
chcp 65001>nul
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 npm。请确认 Node.js 已安装且已加入 PATH。
  pause
  exit /b 1
)

echo 正在启动本地服务（默认 http://localhost:8000）...
echo.
echo 注意：不要用 file:// 直接打开 index.html —— 那样 ES 模块会被 CORS 拦、
echo IndexedDB 也会报 SecurityError，页面根本起不来。
echo.
echo 按 Ctrl+C 停止。
echo.

call npm run serve
pause
