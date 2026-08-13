@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node server\launcher.mjs
echo.
pause
goto :eof

:no_node
echo Node.js was not found.
echo Please install it from https://nodejs.org/ (LTS version),
echo then double-click this file again.
echo.
pause
exit /b 1
