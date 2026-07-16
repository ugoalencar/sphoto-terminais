@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
"%~dp0simplusCameraLib\simplusCamera.exe" /folder "%~dp0images\temp" /wait >> logs\camera.log 2>&1
