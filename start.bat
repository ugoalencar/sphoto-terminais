@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
java -jar "%~dp0start.jar" >> logs\start.log 2>&1
