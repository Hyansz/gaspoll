@echo off
setlocal EnableExtensions
chcp 65001 >nul
title GASPOLL
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto :no_node
node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)"
if errorlevel 1 goto :old_node

node "src\cli.js" %*
set "RC=%errorlevel%"
if "%RC%"=="0" exit /b 0
echo.
echo [!] Program berhenti dengan kode %RC%. Pesan error ada di atas.
echo     Log lengkap tersimpan di folder results\logs
echo.
pause
exit /b %RC%

:no_node
echo.
echo [!] Node.js belum terpasang. Pasang versi 18 ke atas dari https://nodejs.org
echo.
pause
exit /b 1

:old_node
echo.
echo [!] Versi Node.js terlalu lama. Butuh versi 18 ke atas dari https://nodejs.org
echo.
pause
exit /b 1
