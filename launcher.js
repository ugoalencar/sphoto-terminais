// SPhoto - Executor unico: sobe servidor (node), camera e plataforma (java),
// espera cada um ficar de pe e abre as interfaces (index + qa) em janelas de app.
// Funciona em Windows e Linux (camera e Windows-only, o resto e portavel).
// Uso: node launcher.js   (no Windows, via iniciar-tudo.vbs pra rodar sem janela)

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const WIN = process.platform === 'win32';
// Caminho absoluto do cmd.exe - dependendo de quem lancou o node (ex.: shells
// alternativos), "cmd.exe" pode nao estar no PATH e o spawn falha com ENOENT.
const CMD = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
const LOGS = path.join(BASE, 'logs');
if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS);

function log(msg) {
    const linha = '[' + new Date().toLocaleString('pt-BR') + '] ' + msg;
    console.log(linha);
    try { fs.appendFileSync(path.join(LOGS, 'launcher.log'), linha + '\n'); } catch (e) {}
}

function portaOcupada(porta) {
    return new Promise((resolve) => {
        const s = net.connect({ port: porta, host: '127.0.0.1', timeout: 600 });
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
    });
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function esperarPorta(porta, tentativas, intervaloMs) {
    for (let i = 0; i < tentativas; i++) {
        if (await portaOcupada(porta)) return true;
        await esperar(intervaloMs);
    }
    return false;
}

// Dispara um processo desanexado e sem janela - o launcher termina logo em
// seguida, mas os servicos continuam rodando por conta propria.
function rodarOculto(comando, args) {
    const p = spawn(comando, args, {
        cwd: BASE,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
    });
    p.unref();
}

// Via iniciar-oculto.vbs: o windowsHide do spawn nao esconde a janela de forma
// confiavel quando combinado com detached (a janela do java/camera aparecia) -
// o WshShell.Run com flag 0 do VBS esconde de verdade. O VBS ja usa caminho
// absoluto internamente (importa por causa do NoDefaultCurrentDirectoryInExePath).
function rodarBatOculto(nomeArquivo) {
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    rodarOculto(wscript, [path.join(BASE, 'iniciar-oculto.vbs'), nomeArquivo]);
}

async function iniciarServidor() {
    if (await portaOcupada(3000)) {
        log('servidor: ja rodando (porta 3000)');
        return true;
    }
    log('servidor: iniciando...');
    if (WIN) {
        // iniciar-server.bat tem o loop de reinicio automatico
        rodarBatOculto('iniciar-server.bat');
    } else {
        rodarOculto('sh', ['-c', 'while true; do node server.js >> logs/server.log 2>&1; sleep 3; done']);
    }
    const ok = await esperarPorta(3000, 30, 500);
    log(ok ? 'servidor: OK' : 'servidor: NAO subiu - veja logs/server.log');
    return ok;
}

async function iniciarPlataforma() {
    if (await portaOcupada(8099)) {
        log('plataforma: ja rodando (porta 8099)');
        return true;
    }
    log('plataforma: iniciando (start.jar)...');
    if (WIN) {
        rodarBatOculto('start.bat');
    } else {
        rodarOculto('sh', ['-c', 'mkdir -p logs && java -jar start.jar >> logs/start.log 2>&1']);
    }
    const ok = await esperarPorta(8099, 40, 500);
    log(ok ? 'plataforma: OK' : 'plataforma: NAO subiu - veja logs/start.log (Java instalado?)');
    return ok;
}

function iniciarCamera() {
    if (!WIN) {
        log('camera: simplusCamera.exe so roda no Windows - pulando');
        return;
    }
    if (!fs.existsSync(path.join(BASE, 'simplusCameraLib', 'simplusCamera.exe'))) {
        log('camera: simplusCameraLib\\simplusCamera.exe nao encontrado - pulando (pasta fica fora do git, copiar manualmente)');
        return;
    }
    log('camera: iniciando...');
    rodarBatOculto('camera.bat');
}

function acharNavegador() {
    const candidatos = WIN ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ] : [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium'
    ];
    for (const c of candidatos) {
        try { if (c && fs.existsSync(c)) return c; } catch (e) {}
    }
    return null;
}

async function abrirInterfaces() {
    const urls = [
        'http://localhost:3000/index.html',
        'http://localhost:3000/qa.html'
    ];
    const navegador = acharNavegador();
    if (navegador) {
        // Perfil de navegador proprio do SPhoto (pasta .perfil-navegador): o perfil
        // normal do usuario acumula cookies pro localhost que estouram o limite de
        // 8KB de cabecalho do start.jar (Jetty) e o WebSocket da plataforma nunca
        // conecta ("Header is too large 8193>8192"). Perfil dedicado = sempre limpo.
        const perfil = path.join(BASE, '.perfil-navegador');
        for (const url of urls) {
            rodarOculto(navegador, [
                '--user-data-dir=' + perfil,
                '--app=' + url,
                '--no-first-run',
                '--no-default-browser-check'
            ]);
            await esperar(1200);
        }
    } else if (WIN) {
        for (const url of urls) rodarOculto(CMD, ['/c', 'start', '', url]);
    } else {
        for (const url of urls) rodarOculto('xdg-open', [url]);
    }
    log('interfaces abertas: ' + urls.join(' e '));
}

(async function main() {
    log('=== SPhoto executor (' + process.platform + ') ===');
    const servidorOk = await iniciarServidor();
    iniciarCamera();
    await iniciarPlataforma();
    if (servidorOk) {
        await abrirInterfaces();
    } else {
        log('interfaces NAO abertas - servidor nao subiu');
    }
    log('=== pronto ===');
    process.exit(0);
})();
