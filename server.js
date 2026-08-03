const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn, execSync } = require('child_process');
const crypto = require('crypto');
const qaHub = require('./lib/qaHub');
const ocrCadastro = require('./lib/ocrCadastro');
const imagemOcr = require('./lib/imagemOcr');
const cr2Preview = require('./lib/cr2Preview');
const retrabalhoRecebido = require('./lib/retrabalhoRecebido');

// So loga antes de encerrar - depois de um erro nao tratado o processo fica em
// estado indefinido (ex: falhou o listen() da porta), entao NAO deve continuar
// rodando "zumbi". Quem garante resiliencia e o loop de reinicio automatico no
// iniciar-server.bat (reinicia sozinho em poucos segundos apos o exit).
process.on('uncaughtException', (err) => {
    console.error('Erro nao tratado, encerrando para reiniciar:', err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    console.error('Promise rejeitada sem catch, encerrando para reiniciar:', err);
    process.exit(1);
});

// Lanca um .bat oculto (sem janela) e desanexado, sem prender o Node esperando ele
// terminar - camera.bat/start.bat ficam rodando indefinidamente, entao usar exec()
// aqui travaria a resposta HTTP. O proprio .bat redireciona sua saida pra
// logs\<nome>.log - o monitor.html (via /api/status/camera e /api/status/plataforma)
// e quem mostra se deu certo, entao a janela de terminal deixou de ser necessaria.
function iniciarBatDesanexado(nomeArquivo) {
    // Via iniciar-oculto.vbs (WshShell.Run flag 0): o windowsHide do spawn nao
    // esconde a janela de forma confiavel com detached (a janela do java/camera
    // aparecia). Caminhos absolutos por causa do NoDefaultCurrentDirectoryInExePath
    // e de ambientes que lancam o node sem System32 no PATH.
    const wscriptExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const processo = spawn(wscriptExe, [path.join(BASE_PATH, 'iniciar-oculto.vbs'), nomeArquivo], {
        cwd: BASE_PATH,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
    });
    processo.unref();
}

const PORT = 3000;
const BASE_PATH = __dirname;
// Sempre relativo a onde o sphoto esta rodando - nao depende de qual drive/pasta ele foi instalado.
const PASTA_FINALIZADAS = path.join(BASE_PATH, 'Finalizadas');

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

// Arquivos que NUNCA podem sair pelo HTTP.
//
// Por que existe: o handler estatico entrega qualquer arquivo que esteja na pasta do sphoto -
// entao http://localhost:3000/redmine-config.json devolvia a CHAVE DA API do Redmine pra quem
// pedisse. E "so localhost", mas qualquer aba aberta, script ou extensao do navegador lia.
// O .gitignore ja protegia esse arquivo no git; faltava proteger no HTTP.
//
// ATENCAO: redmine-campos.json (o mapa de campos/opcoes) NAO entra aqui - o qa.js busca ele
// pela rede e nao tem segredo nenhum. So bloqueie o que guarda credencial.
const ARQUIVOS_BLOQUEADOS = [
    'redmine-config.json',
    'credencial.txt',
    'credenciais.txt',
    'valores.txt',
    '.env'
];

function ehArquivoBloqueado(caminho) {
    const nome = path.basename(caminho).toLowerCase();
    return ARQUIVOS_BLOQUEADOS.includes(nome) || /\.(key|pem|pfx|p12)$/i.test(nome);
}

function isNomeSeguro(valor) {
    return typeof valor === 'string' && valor.length > 0 &&
        !valor.includes('..') && !valor.includes('/') && !valor.includes('\\');
}

function isSufixoSeguro(valor) {
    return typeof valor === 'string' && /^_[a-zA-Z0-9]+$/.test(valor);
}

// Nome ja no padrao GTIN_dd_MM_yyyy_HH_mm_ss_indice[_sufixo].ext (com ou sem tags extras)
const PADRAO_NOME_NORMALIZADO = /^\d+_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}_\d{2}_\d+(_[a-zA-Z0-9]+)*\.[a-zA-Z0-9]+$/;

// Se o nome (sem extensao) ja segue o padrao GTIN_data_hora_indice, devolve as tags extras
// (ex.: "_coding") que vierem depois do indice, pra nao serem perdidas ao renomear de novo.
function extrairSufixosExtras(semExt) {
    const match = semExt.match(/^\d+_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}_\d{2}_\d+((?:_[a-zA-Z0-9]+)*)$/);
    return match ? match[1] : '';
}

// RT/IS/AP marcadas ainda na pasta temp (palco Atual, antes de salvar) viram sufixo
// no nome (_RT/_IS/_AP), igual _coding - ver aplicarSubpasta() em app.js. Aqui, na hora
// de salvar, tira esse sufixo do nome final e devolve a subpasta correspondente
// (o resto dos sufixos, tipo _coding, continua no nome normalmente).
function separarTagSubpasta(sufixosExtras) {
    let pasta = null;
    let extrasRestantes = sufixosExtras;
    qaHub.SUBPASTAS_TAG.forEach(tag => {
        const marcador = '_' + tag;
        if (extrasRestantes.includes(marcador)) {
            if (!pasta) pasta = tag;
            extrasRestantes = extrasRestantes.split(marcador).join('');
        }
    });
    return { pasta, extrasRestantes };
}

function lerCorpo(req) {
    return new Promise((resolve, reject) => {
        let dados = '';
        req.on('data', chunk => { dados += chunk; });
        req.on('end', () => resolve(dados));
        req.on('error', reject);
    });
}

// Assinatura leve da pasta (nome+tamanho+data de cada imagem) pra usar como ETag.
// Evita reler e rebase64 todas as fotos (algumas com varios MB) a cada poll de 3s
// quando nada mudou desde a ultima vez - so o front pedir de novo com If-None-Match.
function calcularAssinaturaPasta(dirPath) {
    if (!fs.existsSync(dirPath)) return 'vazio';
    const partes = fs.readdirSync(dirPath)
        // RAW entra aqui tambem: se a camera esta em RAW-only, a pasta so tem .cr2 e sem
        // isso a assinatura nunca mudava - o front levava 304 e foto nova nao aparecia.
        .filter(f => /\.(jpg|jpeg|png)$/i.test(f) || ehRawExibivel(f))
        .sort()
        .map(f => {
            const stat = fs.statSync(path.join(dirPath, f));
            return f + ':' + stat.size + ':' + stat.mtimeMs;
        });
    return crypto.createHash('md5').update(partes.join('|')).digest('hex');
}

// Palco "Anterior" (ja salvo) do GTIN, unindo os dois lados gemeos.
//
// Por que existe: em RAW-only a camera nao gera JPG, entao salvarImagens() manda TUDO pro
// lado RAW (OS_x\gtin) e a pasta OCR\OS_x\gtin nem chega a ser criada. O Anterior lia so a
// OCR e ficava vazio - a foto estava salva, mas sumia da tela.
//
// A regra: mostra o JPG da OCR quando ele existe (e o mais leve) e SO cai no RAW pras fotos
// que nao tem gemeo do lado OCR. Assim:
//   - modo jpg+cr2: todo cr2 tem gemeo -> nada e adicionado -> uma entrada por foto (igual antes)
//   - modo RAW-only: nenhum cr2 tem gemeo -> todos entram, exibidos pelo preview embutido
// So arquivo RAW entra pelo lado de la: o JPG final do Lightroom tambem mora em OS_x\gtin,
// mas ele nao e assunto do palco de captura e nao pode aparecer aqui.
function listarImagensAnterior(os, gtin) {
    const pastaOcr = path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + os, gtin);
    const pastaRaw = path.join(PASTA_FINALIZADAS, 'OS_' + os, gtin);

    const imagens = listarImagensBase64(pastaOcr);
    const basesOcr = new Set(imagens.map(i => nomeBaseArquivo(i.nome).toLowerCase()));

    listarImagensBase64(pastaRaw)
        .filter(i => ehRawExibivel(i.nome) && !basesOcr.has(nomeBaseArquivo(i.nome).toLowerCase()))
        .forEach(i => imagens.push(i));

    return imagens;
}

// Subpastas RT/IS/AP do palco Anterior - mesma uniao do listarImagensAnterior, pelo mesmo
// motivo: em RAW-only as subpastas so existem do lado RAW (OCR\OS_x\gtin\RT nem e criada).
function listarSubpastasAnterior(os, gtin) {
    const pastaOcr = path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + os, gtin);
    const pastaRaw = path.join(PASTA_FINALIZADAS, 'OS_' + os, gtin);
    const resultado = {};

    qaHub.SUBPASTAS_TAG.forEach(tag => {
        const imagens = listarImagensBase64(path.join(pastaOcr, tag));
        const basesOcr = new Set(imagens.map(i => nomeBaseArquivo(i.nome).toLowerCase()));

        listarImagensBase64(path.join(pastaRaw, tag))
            .filter(i => ehRawExibivel(i.nome) && !basesOcr.has(nomeBaseArquivo(i.nome).toLowerCase()))
            .forEach(i => imagens.push(i));

        if (imagens.length > 0) resultado[tag] = imagens;
    });

    return resultado;
}

// Assinatura das duas pastas gemeas - o ETag do Anterior tem que mudar quando qualquer um
// dos dois lados mudar, senao em RAW-only o front leva 304 e foto nova nunca aparece.
function assinaturaAnterior(os, gtin) {
    return calcularAssinaturaPasta(path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + os, gtin)) +
        ':' + calcularAssinaturaPasta(path.join(PASTA_FINALIZADAS, 'OS_' + os, gtin));
}

function nomeBaseArquivo(nome) {
    const ext = path.extname(nome);
    return ext ? nome.slice(0, -ext.length) : nome;
}

function listarImagensBase64(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) return [];
        return fs.readdirSync(dirPath)
            .filter(f => /\.(jpg|jpeg|png)$/i.test(f) || ehRawExibivel(f))
            .map(f => {
                // RAW entra pelo preview embutido - sem isso, camera RAW-only some da tela.
                const bytes = bytesParaExibir(path.join(dirPath, f));
                return bytes ? { nome: f, arquivo: bytes.toString('base64') } : null;
            })
            .filter(Boolean);
    } catch (err) {
        console.error('Erro ao ler imagens de', dirPath, err);
        return [];
    }
}

function formatarTimestamp(data) {
    function dois(n) { return String(n).padStart(2, '0'); }
    return dois(data.getDate()) + '_' + dois(data.getMonth() + 1) + '_' + data.getFullYear() +
        '_' + dois(data.getHours()) + '_' + dois(data.getMinutes()) + '_' + dois(data.getSeconds());
}

function obterExtensao(nomeArquivo) {
    const partes = nomeArquivo.split('.');
    return '.' + partes[partes.length - 1];
}

// Fotos que chegam na pasta temp (da camera ou de outro lugar) com nome
// arbitrario sao renomeadas para GTIN_dd_MM_yyyy_HH_mm_ss_indice.ext, usando
// o GTIN selecionado no momento. Arquivos que ja seguem esse padrao (de
// qualquer GTIN, inclusive com sufixo como _coding) nao sao mexidos.
function renomearPastaTemp(gtin) {
    const pastaTemp = path.join(BASE_PATH, 'images', 'temp');
    if (!fs.existsSync(pastaTemp)) return;

    const prefixoGtin = new RegExp('^' + gtin + '_\\d{2}_\\d{2}_\\d{4}_\\d{2}_\\d{2}_\\d{2}_(\\d+)');
    let proximoIndice = 0;

    const arquivos = fs.readdirSync(pastaTemp)
        .filter(nome => fs.statSync(path.join(pastaTemp, nome)).isFile());

    arquivos.forEach(nome => {
        const match = nome.match(prefixoGtin);
        if (match) {
            proximoIndice = Math.max(proximoIndice, parseInt(match[1], 10) + 1);
        }
    });

    arquivos
        .filter(nome => !PADRAO_NOME_NORMALIZADO.test(nome))
        .sort((a, b) => {
            const mtimeA = fs.statSync(path.join(pastaTemp, a)).mtimeMs;
            const mtimeB = fs.statSync(path.join(pastaTemp, b)).mtimeMs;
            return mtimeA - mtimeB;
        })
        .forEach(nome => {
            const origem = path.join(pastaTemp, nome);
            const mtime = fs.statSync(origem).mtime;
            const ext = obterExtensao(nome);
            const novoNome = gtin + '_' + formatarTimestamp(mtime) + '_' + proximoIndice + ext;
            fs.renameSync(origem, path.join(pastaTemp, novoNome));
            proximoIndice++;
        });
}

function garantirPasta(caminho) {
    if (!fs.existsSync(caminho)) fs.mkdirSync(caminho);
}

// Replica o Controller.finalizar() do start.jar: separa os JPGs da pasta temp
// para OCR/OS_<os>/<gtin> e (perfil estudio) o restante (RAW) para OS_<os>/<gtin>,
// gravando a observacao num .txt quando presente. Tudo local, sem falar com o backend Java.
async function salvarImagens(dados) {
    const pastaBase = PASTA_FINALIZADAS;
    const perfilEstudio = (dados.perfil || '').trim().toLowerCase() === 'estudio';
    const timestamp = formatarTimestamp(new Date());

    // Modo OCR (checkbox do topo ligado): o trabalho e SO OCR - o produto final e o JPG na
    // estrutura OCR, e o RAW nao serve pra mais nada depois de virar JPG. Entao nao alimenta
    // Finalizadas\OS_<os>\<gtin> e o CR2 e dispensado. Quando o trabalho e edicao E OCR, o
    // fotografo NAO usa este checkbox: salva normal (RAW vai pro Finalizadas) e escolhe as
    // fotos pelo botao OCR do palco Anterior.
    const modoOcr = dados.modoOcr === true;

    garantirPasta(pastaBase);
    const pastaOcrGtin = path.join(pastaBase, 'OCR', 'OS_' + dados.os, dados.gtin);
    garantirPasta(path.join(pastaBase, 'OCR'));
    garantirPasta(path.join(pastaBase, 'OCR', 'OS_' + dados.os));
    garantirPasta(pastaOcrGtin);

    let pastaRawGtin = null;
    if (perfilEstudio && !modoOcr) {
        garantirPasta(path.join(pastaBase, 'OS_' + dados.os));
        pastaRawGtin = path.join(pastaBase, 'OS_' + dados.os, dados.gtin);
        garantirPasta(pastaRawGtin);
    }

    if (dados.obs && dados.obs.trim() && pastaRawGtin) {
        fs.writeFileSync(path.join(pastaRawGtin, timestamp + '.txt'), dados.obs.trim());
    }

    const pastaTemp = path.join(BASE_PATH, 'images', 'temp');
    let contadorJpg = 0;
    let contadorRaw = 0;
    let movidos = 0;

    // So carrega a config do OCR (e so tenta a rede) quando o modo OCR esta ligado.
    const cfgOcr = modoOcr ? ocrCadastro.carregarConfig() : {};
    const resumoCadastro = { copiados: 0, falharam: 0, motivo: null, ligado: !!cfgOcr.pastaCadastro };

    if (fs.existsSync(pastaTemp)) {
        for (const nomeArquivo of fs.readdirSync(pastaTemp)) {
            const origem = path.join(pastaTemp, nomeArquivo);
            if (!fs.statSync(origem).isFile()) continue;

            const ext = obterExtensao(nomeArquivo);
            const ehJpg = ext.toUpperCase() === '.JPG';
            const semExt = nomeArquivo.slice(0, -ext.length);
            const { pasta: subpastaDestino, extrasRestantes: sufixosExtras } = separarTagSubpasta(extrairSufixosExtras(semExt));

            let pastaDestinoJpg = pastaOcrGtin;
            let pastaDestinoRaw = pastaRawGtin;
            if (subpastaDestino) {
                pastaDestinoJpg = path.join(pastaOcrGtin, subpastaDestino);
                garantirPasta(pastaDestinoJpg);
                if (pastaRawGtin) {
                    pastaDestinoRaw = path.join(pastaRawGtin, subpastaDestino);
                    garantirPasta(pastaDestinoRaw);
                }
            }

            // Modo OCR + arquivo RAW: em vez de mover o CR2, extrai o preview embutido e grava
            // como JPG na estrutura OCR - e so entao descarta o RAW. A ordem importa: se a
            // extracao falhar, o CR2 fica na temp e o fotografo nao perde a foto.
            if (modoOcr && !ehJpg && ehRawExibivel(nomeArquivo)) {
                const preview = bytesParaExibir(origem);
                if (!preview) {
                    console.error('Modo OCR: sem preview embutido em', nomeArquivo, '- CR2 mantido na temp');
                    continue;
                }
                const nomeSaida = dados.gtin + '_' + timestamp + '_' + contadorJpg + sufixosExtras + '.jpg';
                const destinoOcr = path.join(pastaDestinoJpg, nomeSaida);
                fs.writeFileSync(destinoOcr, preview);
                fs.unlinkSync(origem);

                // O trabalho e SO OCR: tem que chegar no Cadastro, senao nao serviu pra nada.
                const copia = ocrCadastro.copiarParaCadastro(
                    cfgOcr, dados.os, dados.gtin, subpastaDestino, destinoOcr, nomeSaida);
                if (copia.estado === 'copiado') resumoCadastro.copiados++;
                else if (copia.estado === 'falhou') {
                    resumoCadastro.falharam++;
                    resumoCadastro.motivo = copia.motivo;
                }

                contadorJpg++;
                movidos++;
                continue;
            }

            // Modo OCR + JPG puro (sem RAW par - camera sem RAW ou RAW-only desligado pra
            // essa foto): nao tem preview leve embutido pra extrair, entao recomprime de
            // verdade (mesma resolucao, qualidade menor) - mesmo efeito de peso que o
            // branch do RAW acima. Sem isso esse arquivo cai no bloco generico debaixo,
            // que so renomeia e NUNCA chamava copiarParaCadastro - o OCR nunca chegava
            // no Cadastro quando a foto era JPG puro.
            if (modoOcr && ehJpg) {
                const recompressao = await imagemOcr.recomprimirParaOcr(origem);
                if (!recompressao.ok) {
                    console.error('Modo OCR: falha ao recomprimir', nomeArquivo, '-', recompressao.motivo, '- arquivo mantido na temp');
                    continue;
                }
                const nomeSaida = dados.gtin + '_' + timestamp + '_' + contadorJpg + sufixosExtras + '.jpg';
                const destinoOcr = path.join(pastaDestinoJpg, nomeSaida);
                fs.writeFileSync(destinoOcr, recompressao.buffer);
                fs.unlinkSync(origem);

                const copia = ocrCadastro.copiarParaCadastro(
                    cfgOcr, dados.os, dados.gtin, subpastaDestino, destinoOcr, nomeSaida);
                if (copia.estado === 'copiado') resumoCadastro.copiados++;
                else if (copia.estado === 'falhou') {
                    resumoCadastro.falharam++;
                    resumoCadastro.motivo = copia.motivo;
                }

                contadorJpg++;
                movidos++;
                continue;
            }

            let destino;
            if (ehJpg) {
                destino = path.join(pastaDestinoJpg, dados.gtin + '_' + timestamp + '_' + contadorJpg + sufixosExtras + ext);
                contadorJpg++;
            } else if (pastaRawGtin) {
                destino = path.join(pastaDestinoRaw, dados.gtin + '_' + timestamp + '_' + contadorRaw + sufixosExtras + ext);
                contadorRaw++;
            } else {
                continue;
            }

            try {
                fs.renameSync(origem, destino);
            } catch (err) {
                if (err.code !== 'EXDEV') throw err;
                // pastaDestino em outro drive - rename direto nao funciona entre volumes
                fs.copyFileSync(origem, destino);
                fs.unlinkSync(origem);
            }
            movidos++;
        }
    }

    return { movidos, cadastro: resumoCadastro };
}

// --- Exibicao de RAW (permite trabalhar RAW-only, sem JPG da camera) ---------------
// A camera pode ser configurada pra gravar SO o RAW (economiza ~20 MB por foto e acaba com
// o pareamento jpg/cr2). Mas a tela precisa de algo exibivel - e todo CR2 ja carrega um JPEG
// de preview embutido (mesma resolucao, ~12x mais leve). Entao: JPG/PNG vao direto, RAW passa
// pelo extrator. Ver lib/cr2Preview.js. Sem isso, camera em RAW-only = palco vazio.
const EXT_RAW_EXIBIVEL = ['.cr2', '.cr3', '.nef', '.arw', '.dng'];

function ehRawExibivel(nome) {
    return EXT_RAW_EXIBIVEL.includes(path.extname(nome).toLowerCase());
}

// Cache do preview extraido, chaveado por caminho+mtime+tamanho. Sem ele, cada render do
// palco releria os 30 MB de cada CR2 do disco. Invalida sozinho se o arquivo mudar.
const cachePreview = new Map();
const LIMITE_CACHE_PREVIEW = 60;

// Bytes JPEG pra exibir uma foto. Devolve null se for RAW e o preview nao puder ser extraido
// (camera de outro modelo) - quem chama deve tratar, nao quebrar a tela inteira por uma foto.
function bytesParaExibir(caminho) {
    if (!ehRawExibivel(caminho)) return fs.readFileSync(caminho);

    let st;
    try { st = fs.statSync(caminho); } catch (err) { return null; }
    const chave = caminho + '|' + st.mtimeMs + '|' + st.size;

    if (cachePreview.has(chave)) return cachePreview.get(chave);

    const preview = cr2Preview.extrairPreview(caminho);
    const bytes = preview.ok ? preview.buffer : null;

    // Descarta o mais antigo quando estoura - e cache de conveniencia, nao pode virar
    // vazamento de memoria numa maquina que fica ligada o dia todo.
    if (cachePreview.size >= LIMITE_CACHE_PREVIEW) {
        cachePreview.delete(cachePreview.keys().next().value);
    }
    cachePreview.set(chave, bytes);
    return bytes;
}

function listImages(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) {
            return [];
        }
        const files = fs.readdirSync(dirPath);
        return files
            .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f) || ehRawExibivel(f))
            .map(f => ({
                nome: f,
                url: '/images/' + path.relative(path.join(BASE_PATH, 'images'), path.join(dirPath, f)).replace(/\\/g, '/')
            }));
    } catch (err) {
        console.error('Erro ao listar imagens:', err);
        return [];
    }
}

// --- Escaner OS_NONE -> OS real -------------------------------------------------
// Fotografamos as vezes um GTIN antes da OS existir no Redmine (fica em OS_NONE).
// Esta rotina consulta o Redmine (mesmo canal que o navegador usa - websocket do
// start.jar na porta 8099) pra cada GTIN parado em OS_NONE; se ja existir uma OS
// real, move a pasta inteira pra dentro dela. Roda por baixo do servidor Node,
// nao precisa do navegador aberto - so do start.jar rodando.

function consultarGtinRedmine(gtin, regraTemplate) {
    return new Promise((resolve, reject) => {
        let resolvido = false;
        const ws = new WebSocket('ws://localhost:8099/events/');

        const timeout = setTimeout(() => {
            if (resolvido) return;
            resolvido = true;
            ws.close();
            reject(new Error('Timeout aguardando resposta da plataforma'));
        }, 15000);

        ws.addEventListener('open', () => {
            const jsonEnvio = regraTemplate.replaceAll('#CAMPO_NOME', 'GTIN').replaceAll('#CAMPO_VALOR', gtin);
            const objRequest = {
                identificador: 'GET',
                rule: JSON.parse(jsonEnvio),
                camposEspecificos: [
                    { nome: 'OS', alias: 'os' },
                    { nome: 'Atualização', alias: 'atualizacao' },
                    { nome: 'Fotógrafo', alias: 'fotografo' },
                    { nome: 'GTIN', alias: 'gtin' },
                    { nome: 'Situação das Imagens', alias: 'situacaoImagem' }
                ]
            };
            ws.send('PLATAFORMA_' + JSON.stringify(objRequest));
        });

        ws.addEventListener('message', (event) => {
            if (resolvido || typeof event.data !== 'string' || !event.data.includes('RET_PLATAFORMA')) return;
            resolvido = true;
            clearTimeout(timeout);
            try {
                resolve(JSON.parse(event.data.substring(14)));
            } catch (err) {
                reject(err);
            } finally {
                ws.close();
            }
        });

        ws.addEventListener('error', () => {
            if (resolvido) return;
            resolvido = true;
            clearTimeout(timeout);
            reject(new Error('Erro de conexao com a plataforma (start.jar rodando?)'));
        });
    });
}

// Move (copia + confere tamanho + apaga a origem) uma pasta de GTIN inteira.
function moverPastaGtin(origem, destino) {
    if (!fs.existsSync(origem)) return 0;
    fs.mkdirSync(destino, { recursive: true });

    const arquivos = fs.readdirSync(origem).filter(nome => fs.statSync(path.join(origem, nome)).isFile());
    let movidos = 0;

    arquivos.forEach(nome => {
        const arquivoOrigem = path.join(origem, nome);
        const arquivoDestino = path.join(destino, nome);
        fs.copyFileSync(arquivoOrigem, arquivoDestino);
        if (fs.statSync(arquivoOrigem).size !== fs.statSync(arquivoDestino).size) {
            throw new Error('Falha ao copiar ' + nome + ' - tamanho nao confere, origem preservada');
        }
        fs.unlinkSync(arquivoOrigem);
        movidos++;
    });

    if (fs.readdirSync(origem).length === 0) {
        fs.rmdirSync(origem);
    }
    return movidos;
}

async function escanearOsNone() {
    const regraPath = path.join(BASE_PATH, 'fotoEstudiougo.json');
    if (!fs.existsSync(regraPath)) {
        throw new Error('Arquivo de regra fotoEstudiougo.json nao encontrado em ' + BASE_PATH);
    }
    const regraTemplate = fs.readFileSync(regraPath, 'utf8');

    const pastaOcrNone = path.join(PASTA_FINALIZADAS, 'OCR', 'OS_NONE');
    const pastaRawNone = path.join(PASTA_FINALIZADAS, 'OS_NONE');

    const listarSubpastas = (dir) => fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(nome => fs.statSync(path.join(dir, nome)).isDirectory())
        : [];

    const gtins = Array.from(new Set([...listarSubpastas(pastaOcrNone), ...listarSubpastas(pastaRawNone)]));
    const resultado = [];

    for (const gtin of gtins) {
        try {
            const resposta = await consultarGtinRedmine(gtin, regraTemplate);
            const demanda = resposta.demandas && resposta.demandas[0];
            const os = demanda && demanda.os;

            if (!os || os === 'NONE') {
                resultado.push({ gtin, status: 'sem_os' });
                continue;
            }

            const movidosOcr = moverPastaGtin(path.join(pastaOcrNone, gtin), path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + os, gtin));
            const movidosRaw = moverPastaGtin(path.join(pastaRawNone, gtin), path.join(PASTA_FINALIZADAS, 'OS_' + os, gtin));

            resultado.push({ gtin, status: 'movido', os, arquivos: movidosOcr + movidosRaw });
        } catch (err) {
            resultado.push({ gtin, status: 'erro', erro: err.message });
        }
    }

    return resultado;
}

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);

    // index.html roda via file:// e chama este servidor via fetch() -
    // precisa liberar CORS (inclusive o preflight OPTIONS do DELETE).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // SPhoto QA Hub (qa.html) - segunda interface, endpoints isolados em lib/qaHub.js
    if (req.url.startsWith('/api/qa/') && qaHub.tratar(req, res)) {
        return;
    }

    if (req.method === 'DELETE' && req.url === '/api/imagem') {
        lerCorpo(req).then(corpo => {
            let dados;
            try {
                dados = JSON.parse(corpo);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'JSON invalido' }));
                return;
            }

            if (!isNomeSeguro(dados.nome)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Nome de arquivo invalido' }));
                return;
            }

            const pastasParaApagar = [];
            if (dados.tipo === 'os') {
                if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Parametros os/gtin invalidos' }));
                    return;
                }
                // JPG de preview (OCR) + RAW irmao (OS_x\gtin, perfil estudio) - apaga os dois.
                pastasParaApagar.push(path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + dados.os, dados.gtin));
                pastasParaApagar.push(path.join(PASTA_FINALIZADAS, 'OS_' + dados.os, dados.gtin));
            } else {
                // Na temp o jpg e o cr2 estao lado a lado.
                pastasParaApagar.push(path.join(BASE_PATH, 'images', 'temp'));
            }

            try {
                let removidos = [];
                pastasParaApagar.forEach(pasta => {
                    removidos = removidos.concat(qaHub.removerPares(pasta, dados.nome));
                });
                if (removidos.length === 0) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Arquivo nao encontrado' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, removidos }));
            } catch (err) {
                console.error('Erro ao deletar imagem:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        }).catch(err => {
            console.error('Erro ao ler corpo da requisicao:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Erro interno' }));
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/salvar') {
        lerCorpo(req).then(async corpo => {
            let dados;
            try {
                dados = JSON.parse(corpo);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'JSON invalido' }));
                return;
            }

            if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parametros os/gtin invalidos' }));
                return;
            }

            try {
                const resultado = await salvarImagens(dados);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, movidos: resultado.movidos, cadastro: resultado.cadastro }));
            } catch (err) {
                console.error('Erro ao salvar imagens:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        }).catch(err => {
            console.error('Erro ao ler corpo da requisicao:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Erro interno' }));
        });
        return;
    }

    // So confirma que o server.js esta de pe (se respondeu, esta rodando) - usado
    // pelo monitor.html, nao envolve tocar em nenhum outro processo/porta.
    if (req.url === '/api/status/servidor') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // Versao exibida no header (tag git da pasta rodando agora) - le direto do git a
    // cada chamada, sem etapa de build. Sem remote configurado nesta pasta (normal
    // aqui no terminal), "git describe" ainda funciona local - cai em 'dev' so se
    // nao for repositorio git de jeito nenhum.
    if (req.url === '/api/versao') {
        exec('git describe --tags --always', { cwd: BASE_PATH }, (err, stdout) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ versao: !err && stdout.trim() ? stdout.trim() : 'dev' }));
        });
        return;
    }

    // So compara HEAD local com origin/main (git fetch, sem baixar/aplicar nada) -
    // alimenta o sininho do header e a tela de config.
    if (req.url === '/api/atualizacao/verificar') {
        try {
            execSync('git fetch origin main --tags', { cwd: BASE_PATH, stdio: 'pipe' });
            const commitsAtras = parseInt(execSync('git rev-list HEAD..origin/main --count', { cwd: BASE_PATH }).toString().trim(), 10) || 0;
            const versaoAtual = execSync('git describe --tags --always', { cwd: BASE_PATH }).toString().trim();
            const versaoDisponivel = execSync('git describe --tags --always origin/main', { cwd: BASE_PATH }).toString().trim();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, versaoAtual, versaoDisponivel, temAtualizacao: commitsAtras > 0 }));
        } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Nao foi possivel consultar atualizacoes (sem rede ou esta pasta nao e um repositorio git)' }));
        }
        return;
    }

    // Traz o codigo novo com "git pull --ff-only" - nunca cria merge/resolve
    // conflito sozinho, entao se a pasta tiver alteracao local nao commitada ou o
    // historico tiver divergido, aborta e devolve erro em vez de arriscar quebrar
    // a pasta. server.js/lib/* rodam dentro do processo Node (carregados uma vez no
    // start) - se mudaram, precisa reiniciar; o resto (html/css/js do navegador) e
    // servido fresco do disco a cada request, so precisa Ctrl+Shift+R.
    if (req.method === 'POST' && req.url === '/api/atualizacao/aplicar') {
        try {
            const statusSujo = execSync('git status --porcelain', { cwd: BASE_PATH }).toString().trim();
            if (statusSujo) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Ha alteracoes locais nao commitadas nesta pasta - resolva manualmente (git status) antes de atualizar' }));
                return;
            }
            const antes = execSync('git rev-parse HEAD', { cwd: BASE_PATH }).toString().trim();
            execSync('git pull --ff-only origin main', { cwd: BASE_PATH, stdio: 'pipe' });
            const depois = execSync('git rev-parse HEAD', { cwd: BASE_PATH }).toString().trim();
            const arquivosMudados = antes === depois ? [] : execSync('git diff --name-only ' + antes + ' ' + depois, { cwd: BASE_PATH })
                .toString().trim().split('\n').filter(Boolean);
            const precisaReiniciar = arquivosMudados.some((f) => f === 'server.js' || f.startsWith('lib/'));
            const versaoAtual = execSync('git describe --tags --always', { cwd: BASE_PATH }).toString().trim();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, jaEstavaAtualizado: antes === depois, versaoAtual, arquivosMudados, precisaReiniciar }));
        } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'git pull falhou: ' + (err.message || String(err)).slice(0, 500) }));
        }
        return;
    }

    // O processo simplusCamera.exe fica de pe mesmo depois que a camera fisica e
    // desligada/desconectada (ele nao morre sozinho) - checar so o processo (tasklist)
    // faz o status ficar preso em "conectada" pra sempre depois da primeira conexao.
    // Cruza com o dispositivo USB real (Get-PnpDevice) pra saber se a EOS esta
    // fisicamente presente agora.
    if (req.url === '/api/status/camera') {
        // @(...) forca contexto de array - no Windows PowerShell 5.1, quando o
        // Where-Object da exatamente 1 resultado (objeto solto, nao array), ".Count"
        // some (nao da erro, so fica vazio) e o parseInt vira NaN -> falso negativo.
        const psVerificaCamera = 'powershell -NoProfile -Command "(@(Get-PnpDevice | Where-Object { $_.Class -eq \'WPD\' -and $_.FriendlyName -match \'EOS\' -and $_.Present -eq $true })).Count"';
        exec(psVerificaCamera, (errPs, stdoutPs) => {
            const cameraPresente = !errPs && parseInt((stdoutPs || '0').trim(), 10) > 0;
            exec('tasklist /FI "IMAGENAME eq simplusCamera*"', (errTl, stdoutTl) => {
                const processoRodando = !errTl && /simplusCamera/i.test(stdoutTl);
                const conectada = processoRodando && cameraPresente;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ conectada, processoRodando, cameraPresente }));
            });
        });
        return;
    }

    // Confere se o start.jar esta de pe olhando o estado da porta 8099 direto no SO
    // (netstat) - abrir e derrubar uma conexao TCP crua nele (como fazia antes)
    // confundia o parser HTTP do Jetty ("Header is too large") e podia atrapalhar
    // a conexao real do WebSocket. So ler o estado da porta nao toca no socket do Jetty.
    if (req.url === '/api/status/plataforma') {
        exec('netstat -ano', (err, stdout) => {
            const conectada = !err && (stdout || '').split('\n').some((linha) => {
                const partes = linha.trim().split(/\s+/);
                return partes[0] === 'TCP' && /:8099$/.test(partes[1] || '') && partes[3] === 'LISTENING';
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ conectada }));
        });
        return;
    }

    // simplusCameraLib/ e pasta grande de terceiros, fora do git (.gitignore) - se a
    // pasta sphoto foi copiada sem ela (ex.: via git em vez de copia de arquivo), o
    // camera.bat abre e fecha na hora reclamando que nao acha o .exe. Confere antes
    // de tentar, em vez de responder "ok" e deixar isso passar em silencio.
    if (req.method === 'POST' && req.url === '/api/iniciar/camera') {
        const caminhoExeCamera = path.join(BASE_PATH, 'simplusCameraLib', 'simplusCamera.exe');
        if (!fs.existsSync(caminhoExeCamera)) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                ok: false,
                error: 'simplusCameraLib\\simplusCamera.exe não encontrado nesta máquina. Essa pasta é grande e fica fora do git - precisa ser copiada manualmente.'
            }));
        }
        try {
            iniciarBatDesanexado('camera.bat');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (err) {
            console.error('Erro ao iniciar camera.bat:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    // start.bat so faz "java -jar start.jar" - sem essa checagem, numa maquina sem
    // Java instalado o .bat abre e fecha na hora (sem pause, sem nada visivel) e o
    // fetch aqui responde "ok" mesmo assim, porque so o spawn do cmd.exe foi o que
    // funcionou. Checar o java antes evita esse falso-positivo silencioso.
    if (req.method === 'POST' && req.url === '/api/iniciar/plataforma') {
        exec('java -version', errJava => {
            if (errJava) {
                console.error('Java nao encontrado ao tentar iniciar start.bat:', errJava.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    ok: false,
                    error: 'Java não encontrado nesta máquina. Instale o Java (JRE) e tente novamente.'
                }));
            }
            try {
                iniciarBatDesanexado('start.bat');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (err) {
                console.error('Erro ao iniciar start.bat:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/scan-os-none') {
        escanearOsNone().then(resultado => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, resultado }));
        }).catch(err => {
            console.error('Erro ao escanear OS_NONE:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });
        return;
    }

    if (req.url.startsWith('/api/imagens/temp')) {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const gtin = query.get('gtin') || '';

        if (gtin && gtin !== 'NONE' && isNomeSeguro(gtin)) {
            try {
                renomearPastaTemp(gtin);
            } catch (err) {
                console.error('Erro ao renomear pasta temp:', err);
            }
        }

        const tempPath = path.join(BASE_PATH, 'images', 'temp');
        const assinatura = calcularAssinaturaPasta(tempPath);

        if (req.headers['if-none-match'] === assinatura) {
            res.writeHead(304, { 'ETag': assinatura });
            res.end();
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': assinatura });
        res.end(JSON.stringify({ imagens: listarImagensBase64(tempPath) }));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/marcar') {
        lerCorpo(req).then(corpo => {
            let dados;
            try {
                dados = JSON.parse(corpo);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'JSON invalido' }));
                return;
            }

            if (!Array.isArray(dados.arquivos) || dados.arquivos.length === 0 || !isSufixoSeguro(dados.sufixo)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parametros arquivos/sufixo invalidos' }));
                return;
            }

            const pastasAlvo = [];
            if (dados.tipo === 'os') {
                if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Parametros os/gtin invalidos' }));
                    return;
                }
                // JPG de preview (OCR) + RAW irmao (OS_x\gtin) recebem o mesmo sufixo.
                pastasAlvo.push(path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + dados.os, dados.gtin));
                pastasAlvo.push(path.join(PASTA_FINALIZADAS, 'OS_' + dados.os, dados.gtin));
            } else {
                // Na temp o jpg e o cr2 estao lado a lado.
                pastasAlvo.push(path.join(BASE_PATH, 'images', 'temp'));
            }

            const renomeados = {};

            try {
                dados.arquivos.forEach(nome => {
                    if (!isNomeSeguro(nome)) return;
                    // Direcao do toggle decidida pelo arquivo pedido; aplicada ao par (jpg + cr2).
                    const remover = qaHub.nomeBase(nome).endsWith(dados.sufixo);
                    pastasAlvo.forEach(pasta => {
                        qaHub.paresNaPasta(pasta, nome).forEach(f => {
                            const ext = obterExtensao(f);
                            const semExt = f.slice(0, -ext.length);
                            let novo = f;
                            if (remover && semExt.endsWith(dados.sufixo)) {
                                novo = semExt.slice(0, -dados.sufixo.length) + ext;
                            } else if (!remover && !semExt.endsWith(dados.sufixo)) {
                                novo = semExt + dados.sufixo + ext;
                            }
                            if (novo !== f) fs.renameSync(path.join(pasta, f), path.join(pasta, novo));
                            renomeados[f] = novo;
                        });
                    });
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, renomeados: renomeados }));
            } catch (err) {
                console.error('Erro ao marcar imagens:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        }).catch(err => {
            console.error('Erro ao ler corpo da requisicao:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Erro interno' }));
        });
        return;
    }

    // RT/IS/AP no palco Anterior (index.html, imagem ja salva) - move de fato o arquivo
    // pra subpasta, mesmo mecanismo que a QA Hub usa, so que na pasta OCR (o que o index
    // ja mostra). No palco Atual/temp o marcador e so um sufixo no nome (via /api/marcar,
    // ver aplicarSubpasta() em app.js) - a subpasta real so nasce em salvarImagens().
    if (req.method === 'POST' && req.url === '/api/tag-subpasta') {
        lerCorpo(req).then(corpo => {
            let dados;
            try {
                dados = JSON.parse(corpo);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'JSON invalido' }));
                return;
            }

            if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parametros os/gtin invalidos' }));
                return;
            }
            if (!qaHub.SUBPASTAS_TAG.includes(dados.pasta)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Pasta deve ser RT, IS ou AP' }));
                return;
            }
            if (!Array.isArray(dados.arquivos) || dados.arquivos.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parametro arquivos invalido' }));
                return;
            }

            try {
                const pastaAlvo = path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + dados.os, dados.gtin);
                const movidos = qaHub.moverParaSubpasta(pastaAlvo, dados.arquivos, dados.pasta);
                // RAW irmao do fotografo (perfil estudio) mora na pasta paralela sem OCR -
                // move junto pra mesma subpasta, quando existir.
                const pastaRaw = path.join(PASTA_FINALIZADAS, 'OS_' + dados.os, dados.gtin);
                if (fs.existsSync(pastaRaw)) {
                    qaHub.moverParaSubpasta(pastaRaw, dados.arquivos, dados.pasta);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, movidos }));
            } catch (err) {
                console.error('Erro ao mover para subpasta:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        }).catch(err => {
            console.error('Erro ao ler corpo da requisicao:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Erro interno' }));
        });
        return;
    }

    // Gera o JPG de OCR do GTIN (do preview embutido no RAW) e copia pra pasta do Cadastro.
    // So mexe em ARQUIVO: quem escreve 'Foto (OCR)' no Redmine e o robo do Cadastro, que roda
    // em outra maquina e so pega o GTIN se estiver em 'Aguardando Inicio'. Quem entrega e dono
    // do status - marcar "Concluido" daqui faria o Redmine mentir se o robo estivesse parado.
    // Sem "arquivos" no corpo, gera o GTIN inteiro (idempotente: regerar so sobrescreve).
    if (req.method === 'POST' && req.url === '/api/ocr/gerar') {
        lerCorpo(req).then(async corpo => {
            let dados;
            try {
                dados = JSON.parse(corpo);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'JSON invalido' }));
                return;
            }

            if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Parametros os/gtin invalidos' }));
                return;
            }

            try {
                const resultado = await ocrCadastro.gerarOcr(dados.os, dados.gtin, dados.arquivos);
                res.writeHead(resultado.erro ? 404 : 200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(resultado));
            } catch (err) {
                // Pasta de rede fora do ar / config errada cai aqui - a mensagem vai pra tela.
                console.error('Erro ao gerar OCR:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        }).catch(err => {
            console.error('Erro ao ler corpo da requisicao:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Erro interno' }));
        });
        return;
    }

    // Conteudo das subpastas RT/IS/AP (lado OCR) do GTIN atual - o index.html usa isso
    // pra mostrar o que foi marcado e dar chance de reverter (senao a foto so some).
    if (req.url.startsWith('/api/imagens/subpastas')) {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const os = query.get('os') || '';
        const gtin = query.get('gtin') || '';

        if (!isNomeSeguro(os) || !isNomeSeguro(gtin)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Parametros os/gtin invalidos' }));
            return;
        }

        // Une OCR + RAW (ver listarSubpastasAnterior) - em RAW-only as subpastas so existem
        // do lado RAW, e o preview do RT/IS/AP ficava vazio.
        const subpastas = listarSubpastasAnterior(os, gtin);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, subpastas }));
        return;
    }

    if (req.url.startsWith('/api/imagens/anterior')) {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const os = query.get('os') || '';
        const gtin = query.get('gtin') || '';

        if (!isNomeSeguro(os) || !isNomeSeguro(gtin)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Parametros os/gtin invalidos' }));
            return;
        }

        // Une os dois lados gemeos (OCR/jpg + RAW/cr2) - sem isso, camera em RAW-only
        // deixava o palco Anterior vazio, porque a pasta OCR nem chega a existir.
        const assinatura = assinaturaAnterior(os, gtin);

        if (req.headers['if-none-match'] === assinatura) {
            res.writeHead(304, { 'ETag': assinatura });
            res.end();
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': assinatura });
        res.end(JSON.stringify({ imagens: listarImagensAnterior(os, gtin) }));
        return;
    }

    // Retrabalho recebido de volta do QA (pasta que a regra RECEIVER do syncIMG.jar
    // entrega em C:\SyncIMGSend\Retrabalho) - mostra pro fotografo quais fotos/motivos
    // precisam ser refeitos antes dele recapturar. So aparece quando ha dado de verdade;
    // ausencia (regra RECEIVER nao instalada, ou retrabalho ainda nao chegou) nao e erro.
    if (req.url.startsWith('/api/retrabalho')) {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const os = query.get('os') || '';
        const gtin = query.get('gtin') || '';

        if (!isNomeSeguro(os) || !isNomeSeguro(gtin)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Parametros os/gtin invalidos' }));
            return;
        }

        const encontrado = retrabalhoRecebido.buscarRetrabalhoRecebido(os, gtin);
        const retrabalho = encontrado
            ? { motivos: encontrado.motivos, fotos: listarImagensBase64(encontrado.pastaGtinPath) }
            : null;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, retrabalho }));
        return;
    }

    if (req.url === '/api/temp') {
        const tempPath = path.join(BASE_PATH, 'images', 'temp');
        const images = listImages(tempPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(images));
        return;
    }

    if (req.url.startsWith('/api/os/')) {
        const parts = req.url.split('/');
        const os = parts[3];
        const gtin = parts[4];
        const osPath = path.join(BASE_PATH, 'images', 'finalizadas', 'ocr', os, gtin || '');
        const images = listImages(osPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(images));
        return;
    }

    if (req.url === '/api/scan') {
        const tempPath = path.join(BASE_PATH, 'images', 'temp');
        const tempImages = listImages(tempPath);

        const ocrBase = path.join(BASE_PATH, 'images', 'finalizadas', 'ocr');
        let osImages = [];
        try {
            if (fs.existsSync(ocrBase)) {
                const osDirs = fs.readdirSync(ocrBase);
                osDirs.forEach(os => {
                    const osDir = path.join(ocrBase, os);
                    if (fs.statSync(osDir).isDirectory()) {
                        const gtinDirs = fs.readdirSync(osDir);
                        gtinDirs.forEach(gtin => {
                            const gtinDir = path.join(osDir, gtin);
                            if (fs.statSync(gtinDir).isDirectory()) {
                                const imgs = listImages(gtinDir);
                                imgs.forEach(img => {
                                    img.os = os;
                                    img.gtin = gtin;
                                });
                                osImages = osImages.concat(imgs);
                            }
                        });
                    }
                });
            }
        } catch (err) {
            console.error('Erro ao escanear OS:', err);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ temp: tempImages, os: osImages }));
        return;
    }

    const urlSemQuery = req.url.split('?')[0]; // tira ?hash (ex: fonte.woff2?abc) senao 404
    let filePath = path.join(BASE_PATH, urlSemQuery === '/' ? 'teste-standalone.html' : urlSemQuery);

    // Credencial nao sai pela porta 3000 - ver ARQUIVOS_BLOQUEADOS.
    if (ehArquivoBloqueado(filePath)) {
        console.error('Bloqueado acesso HTTP a arquivo sensivel:', urlSemQuery);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Acesso negado');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // RAW pedido pela tela (ex: /images/temp/foto.CR2): devolve o JPEG embutido no lugar dos
    // bytes crus, que o navegador nao sabe exibir. O <img src> do front nao muda nada.
    if (ehRawExibivel(filePath)) {
        const preview = bytesParaExibir(filePath);
        if (!preview) {
            res.writeHead(415, { 'Content-Type': 'text/plain' });
            res.end('Sem preview embutido neste RAW');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(preview);
        return;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Arquivo nao encontrado');
            } else {
                res.writeHead(500);
                res.end('Erro interno');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  SPhoto Test Server rodando em:`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`========================================\n`);
    console.log(`Pastas monitoradas:`);
    console.log(`  Temp:        ${path.join(BASE_PATH, 'images', 'temp')}`);
    console.log(`  Finalizadas: ${PASTA_FINALIZADAS}`);
    console.log(`\nColoque imagens nas pastas e acesse o navegador.\n`);
});
