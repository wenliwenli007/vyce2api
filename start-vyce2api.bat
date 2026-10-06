@echo off
rem vyce2api 一键启动（双击即启）
rem API Key 存于 settings.json（首次启动自动生成，终端打印）
cd /d %~dp0
echo.
echo   Base URL : http://127.0.0.1:8788/v1
echo   Panel    : http://127.0.0.1:8788/  (默认密码 admin)
echo   API Key  :
node vyce2api.js key
echo.
node vyce2api.js serve 8788
pause
