@echo off
chcp 65001>nul
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 npm。请确认 Node.js 已安装且已加入 PATH。
  pause
  exit /b 1
)

call npm run build
if errorlevel 1 (
  echo.
  echo [失败] 构建未通过，请检查上面的报错。
  pause
  exit /b 1
)

echo.
echo 构建完成：app.js
pause
