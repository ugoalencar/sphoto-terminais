@echo off
REM Coleta TUDO que se precisa saber pra diagnosticar um terminal que nao sobe, e
REM joga num arquivo unico (diagnostico.txt) pra mandar pra analise. So LE - nao muda
REM nada, nao inicia nada, nao apaga nada. Pode rodar a vontade.
cd /d "%~dp0"
set SAIDA=diagnostico.txt

echo ============================================ > %SAIDA%
echo  SPHOTO - DIAGNOSTICO DO TERMINAL >> %SAIDA%
echo  Gerado em: %DATE% %TIME% >> %SAIDA%
echo  Pasta: %~dp0 >> %SAIDA%
echo  Maquina: %COMPUTERNAME%  ^|  Usuario: %USERNAME% >> %SAIDA%
echo ============================================ >> %SAIDA%
echo. >> %SAIDA%

echo --- [1] JAVA (a Plataforma/start.jar depende dele) --- >> %SAIDA%
java -version >> %SAIDA% 2>&1
if errorlevel 1 echo   ^>^>^> JAVA NAO ENCONTRADO NO PATH >> %SAIDA%
echo. >> %SAIDA%

echo --- [2] NODE (o Servidor depende dele) --- >> %SAIDA%
node -v >> %SAIDA% 2>&1
if errorlevel 1 echo   ^>^>^> NODE NAO ENCONTRADO NO PATH >> %SAIDA%
echo. >> %SAIDA%

echo --- [3] ARQUIVOS ESSENCIAIS (a copia veio completa?) --- >> %SAIDA%
for %%A in (start.jar server.js index.html qa.html monitor.html launcher.js start.bat camera.bat iniciar-server.bat) do (
  if exist "%%A" (echo   OK    %%A) else (echo   FALTA %%A)
) >> %SAIDA% 2>&1
if exist "simplusCameraLib\simplusCamera.exe" (echo   OK    simplusCameraLib\simplusCamera.exe) else (echo   FALTA simplusCameraLib\simplusCamera.exe) >> %SAIDA% 2>&1
if exist "js\vue.global.js" (echo   OK    js\vue.global.js ^(offline^)) else (echo   FALTA js\vue.global.js - QA vai abrir EM BRANCO sem internet) >> %SAIDA% 2>&1
if exist "css\bootstrap-icons.css" (echo   OK    css\bootstrap-icons.css) else (echo   FALTA css\bootstrap-icons.css) >> %SAIDA% 2>&1
echo. >> %SAIDA%

echo --- [4] PORTAS (3000 = servidor, 8099 = plataforma) --- >> %SAIDA%
echo   [porta 3000] >> %SAIDA%
netstat -ano | findstr ":3000" >> %SAIDA% 2>&1
if errorlevel 1 echo     nada escutando na 3000 >> %SAIDA%
echo   [porta 8099] >> %SAIDA%
netstat -ano | findstr ":8099" >> %SAIDA% 2>&1
if errorlevel 1 echo     nada escutando na 8099 >> %SAIDA%
echo. >> %SAIDA%

echo --- [5] PROCESSOS RODANDO --- >> %SAIDA%
tasklist /fi "imagename eq java.exe" 2>&1 | findstr /i "java.exe" >> %SAIDA%
if errorlevel 1 echo   java.exe NAO esta rodando >> %SAIDA%
tasklist /fi "imagename eq node.exe" 2>&1 | findstr /i "node.exe" >> %SAIDA%
if errorlevel 1 echo   node.exe NAO esta rodando >> %SAIDA%
tasklist /fi "imagename eq simplusCamera.exe" 2>&1 | findstr /i "simplusCamera" >> %SAIDA%
if errorlevel 1 echo   simplusCamera.exe NAO esta rodando >> %SAIDA%
echo. >> %SAIDA%

echo --- [6] LOG DA PLATAFORMA (start.log) - AQUI COSTUMA ESTAR A RESPOSTA --- >> %SAIDA%
if exist "logs\start.log" (
  powershell -NoProfile -Command "Get-Content 'logs\start.log' -Tail 40" >> %SAIDA% 2>&1
) else (
  echo   logs\start.log NAO EXISTE - o start.bat talvez nem tenha rodado >> %SAIDA%
)
echo. >> %SAIDA%

echo --- [7] LOG DO SERVIDOR (server.log) --- >> %SAIDA%
if exist "logs\server.log" (
  powershell -NoProfile -Command "Get-Content 'logs\server.log' -Tail 20" >> %SAIDA% 2>&1
) else (
  echo   logs\server.log nao existe >> %SAIDA%
)
echo. >> %SAIDA%

echo --- [8] LOG DA CAMERA (camera.log) --- >> %SAIDA%
if exist "logs\camera.log" (
  powershell -NoProfile -Command "Get-Content 'logs\camera.log' -Tail 15" >> %SAIDA% 2>&1
) else (
  echo   logs\camera.log nao existe >> %SAIDA%
)
echo. >> %SAIDA%

echo --- [9] TESTE DIRETO DA PLATAFORMA (porta 8099 responde?) --- >> %SAIDA%
powershell -NoProfile -Command "try { $c = Test-NetConnection -ComputerName localhost -Port 8099 -WarningAction SilentlyContinue; 'TcpTestSucceeded: ' + $c.TcpTestSucceeded } catch { 'falhou: ' + $_ }" >> %SAIDA% 2>&1
echo. >> %SAIDA%

echo --- [10] FIREWALL (pode estar derrubando a conexao) --- >> %SAIDA%
powershell -NoProfile -Command "Get-NetFirewallProfile 2>$null | Select-Object Name,Enabled | Format-Table -AutoSize | Out-String" >> %SAIDA% 2>&1
echo. >> %SAIDA%

echo --- [11] PERFIL DEDICADO DO NAVEGADOR (cookie grande derruba o Jetty) --- >> %SAIDA%
if exist ".perfil-navegador" (echo   OK    .perfil-navegador existe - o atalho abre limpo) else (echo   ainda nao existe - so nasce quando abre pelo atalho/launcher) >> %SAIDA% 2>&1
echo. >> %SAIDA%

echo ============================================ >> %SAIDA%
echo  FIM >> %SAIDA%
echo ============================================ >> %SAIDA%

echo.
echo   Diagnostico gerado em: %~dp0%SAIDA%
echo   Abra o arquivo e mande o conteudo pra analise.
echo.
REM start "" = abre o notepad SEM travar o bat esperando ele fechar
start "" notepad %SAIDA%
