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
rem O repositorio e privado, entao cada terminal usa sua PROPRIA chave SSH (deploy
rem key, somente leitura) em vez de senha - assim da pra revogar so uma maquina se
rem precisar, sem afetar as outras. A chave fica em %USERPROFILE%\.ssh, nunca sai
rem desta maquina - so a metade PUBLICA e colada no GitHub.
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
    echo ERRO: git nao encontrado nesta maquina. Instale o Git for Windows primeiro
    echo ^(https://git-scm.com/download/win^) e rode este arquivo de novo.
    pause
    exit /b 1
)

where ssh-keygen >nul 2>&1
if errorlevel 1 (
    echo ERRO: ssh-keygen nao encontrado ^(deveria vir junto com o Git for Windows^).
    echo Reinstale o Git marcando a opcao padrao de OpenSSH e rode este arquivo de novo.
    pause
    exit /b 1
)

if exist .git (
    echo Esta pasta ja esta conectada ao git. Nada a fazer aqui - use "Verificar
    echo atualizacao" na engrenagem do SPhoto pra pegar novidades.
    pause
    exit /b 0
)

set CHAVE=%USERPROFILE%\.ssh\sphoto_terminal_deploy_key

if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh"

if not exist "%CHAVE%" (
    echo Gerando chave de acesso exclusiva deste computador...
    ssh-keygen -t ed25519 -f "%CHAVE%" -N "" -C "sphoto-terminal-%COMPUTERNAME%"
    if errorlevel 1 (
        echo ERRO ao gerar a chave SSH.
        pause
        exit /b 1
    )
)

echo.
echo ============================================================
echo  PASSO MANUAL - so na PRIMEIRA vez, antes de continuar:
echo.
echo  1. Copie a linha abaixo (a chave PUBLICA - pode compartilhar):
echo.
type "%CHAVE%.pub"
echo.
echo  2. Abra: https://github.com/ugoalencar/sphoto-terminais/settings/keys
echo  3. Clique "Add deploy key", cole a linha, NAO marque "Allow write
echo     access" (precisa ficar so leitura), e salve.
echo ============================================================
echo.
pause

echo Conectando esta pasta ao repositorio de atualizacoes...
git init -q
git remote add origin git@github.com:ugoalencar/sphoto-terminais.git
git config core.sshCommand "ssh -i \"%CHAVE%\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if errorlevel 1 (
    echo ERRO ao configurar o remote. Veja a mensagem acima.
    pause
    exit /b 1
)

echo Baixando a versao mais recente...
git fetch origin main
if errorlevel 1 (
    echo ERRO ao baixar do GitHub - confira se a chave foi cadastrada certo no
    echo passo anterior, e a internet desta maquina.
    pause
    exit /b 1
)

git reset --hard origin/main

echo.
echo Pronto! Esta pasta esta na versao mais recente e conectada ao GitHub.
echo Feche o SPhoto (parar.bat) e abra de novo pelo atalho pra aplicar de vez.
echo Daqui pra frente, use "Verificar atualizacao" na engrenagem.
pause
