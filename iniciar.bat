@echo off
rem Mesmo fluxo do atalho da area de trabalho, so que com janela visivel
rem mostrando o progresso - util pra diagnosticar quando algo nao sobe.
cd /d "%~dp0"
node launcher.js
pause
