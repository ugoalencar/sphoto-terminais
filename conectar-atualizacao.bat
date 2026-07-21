@echo off
rem Roda UMA VEZ em cada terminal que ainda e uma copia solta da pasta (sem git),
rem pra ligar essa pasta no repositorio de atualizacoes do sphoto-terminais.
rem Depois disso, o botao "Verificar atualizacao" da engrenagem passa a funcionar.
rem
rem Seguro pra rodar numa pasta que ja esta em uso: so mexe nos arquivos de CODIGO
rem (o mesmo conjunto que esta no GitHub). redmine-config.json, caminhos-locais.json,
rem Finalizadas\, images\, logs\, simplusCameraLib\, start.jar e qualquer outra coisa
rem local NAO fazem parte do repositorio e ficam intocados.
rem
rem Repositorio e publico - git fetch/pull funciona sem senha nem chave em nenhum
rem terminal (so leitura, ninguem de fora consegue empurrar nada pra ca).
rem
rem O "git reset --hard" la embaixo pode sobrescrever ESTE MESMO arquivo (ele e
rem parte do repositorio) enquanto ainda esta rodando, e o cmd.exe se perde lendo
rem um .bat que mudou de baixo dele no meio da execucao. Por isso a copia pra %TEMP%
rem e reexecucao logo abaixo - so ai e seguro chegar perto do reset.
if not "%~1"=="_copia" (
    copy /y "%~f0" "%TEMP%\conectar-atualizacao-run.bat" >nul
    call "%TEMP%\conectar-atualizacao-run.bat" _copia "%~dp0"
    exit /b %errorlevel%
)
cd /d "%~2"

where git >nul 2>&1
if errorlevel 1 (
    echo ERRO: git nao encontrado nesta maquina. Instale o Git for Windows primeiro
    echo ^(https://git-scm.com/download/win^) e rode este arquivo de novo.
    pause
    exit /b 1
)

if exist .git (
    echo Esta pasta ja esta conectada ao git. Nada a fazer aqui - use "Verificar
    echo atualizacao" na engrenagem do SPhoto pra pegar novidades.
    pause
    exit /b 0
)

echo Conectando esta pasta ao repositorio de atualizacoes...
git init -q
git remote add origin https://github.com/ugoalencar/sphoto-terminais.git
if errorlevel 1 (
    echo ERRO ao configurar o remote. Veja a mensagem acima.
    pause
    exit /b 1
)

echo Baixando a versao mais recente...
git fetch origin main
if errorlevel 1 (
    echo ERRO ao baixar do GitHub - confira a internet desta maquina.
    pause
    exit /b 1
)

git reset --hard origin/main

echo.
echo Pronto! Esta pasta esta na versao mais recente e conectada ao GitHub.
echo Feche o SPhoto (parar.bat) e abra de novo pelo atalho pra aplicar de vez.
echo Daqui pra frente, use "Verificar atualizacao" na engrenagem.
pause
