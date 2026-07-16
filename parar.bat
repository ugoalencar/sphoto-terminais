@echo off
rem Encerra tudo do SPhoto: servidor (node), camera e plataforma (java),
rem inclusive o loop que reinicia o servidor sozinho. Cada regra e presa ao
rem nome do processo certo pra nao pegar outra coisa por engano.
echo Encerrando o SPhoto...

powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*') -or ($_.Name -eq 'java.exe' -and $_.CommandLine -like '*start.jar*') -or ($_.Name -eq 'cmd.exe' -and ($_.CommandLine -like '*iniciar-server.bat*' -or $_.CommandLine -like '*camera.bat*' -or $_.CommandLine -like '*start.bat*')) -or ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*iniciar-*') -or $_.Name -eq 'simplusCamera.exe' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"

echo.
echo SPhoto encerrado. Pode fechar esta janela.
pause
