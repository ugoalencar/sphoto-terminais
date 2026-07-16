@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
node server.js >> logs\server.log 2>&1
echo [%date% %time%] server.js encerrou - reiniciando em 3s >> logs\server.log
timeout /t 3 /nobreak >nul
goto loop
