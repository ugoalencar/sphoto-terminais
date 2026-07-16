// Backend da SPhoto QA Hub - segunda interface (qa.html), separada da captura ao vivo
// (index.html/server.js). Le e organiza pastas ja finalizadas em Finalizadas\OS_<os>\<gtin>
// e escreve os campos de fotografia direto no Redmine via REST.
//
// Importante: a pasta que importa aqui e Finalizadas\OS_<os>\<gtin> (JPG final exportado
// do Lightroom apos editar o RAW), NAO Finalizadas\OCR\OS_<os>\<gtin> (JPG de baixa
// resolucao, so referencia visual da captura). Ver redmine-campos.json para o mapa de
// campos/opcoes do Redmine.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cr2Preview = require('./cr2Preview');

const BASE_PATH = path.join(__dirname, '..');
const PASTA_FINALIZADAS = path.join(BASE_PATH, 'Finalizadas');
const MARCADOR_ENVIADO = 'sphoto-qa-enviado.json';
const SUBPASTAS_TAG = ['RT', 'IS', 'AP'];
const SUBPASTAS_DESTINO = ['Mockup', 'Recorte'];

// Robo externo (C:\Apps\Syncimg) que sobe as fotos pro S3 (bucket WaitingConference)
// pra ficarem disponiveis pros terceiros/home office - so pega o GTIN se a Situacao
// das Imagens no Redmine estiver "Aguardando QA Fotografia" (19), ai ele mesmo muda
// pra "Ag. Conferencia" (154) depois do upload. Ver SYNCIMG_SEND_IMAGES_FOTOGRAFADAS.json.
// Por isso o QA Hub so grava os campos extras (responsavel/quantidades) DEPOIS que o
// robo ja rodou - nao mexemos na Situacao das Imagens nessa etapa.
const SYNCIMG_BASE = 'C:\\Apps\\Syncimg';
const SYNCIMG_AGENVIO = path.join(SYNCIMG_BASE, 'Fotografados', 'AgEnvio');
const SYNCIMG_ENVIADAS = path.join(SYNCIMG_BASE, 'Fotografados', 'Enviadas');
const SYNCIMG_BAT = 'syncIMG-EnviaConferencia.bat';
const EXTENSOES_ENVIO_CONFERENCIA = ['.jpg', '.jpeg', '.png', '.cr2'];

// Extensoes que andam em PAR pelo mesmo nome-base: o JPG de preview/edicao e o RAW
// do fotografo. Qualquer acao (mover pra subpasta, deletar, marcar sufixo) feita no
// JPG tem que pegar o RAW irmao junto, quando existir. Ver nomeBase/paresNaPasta.
const EXTENSOES_PAR = ['.jpg', '.jpeg', '.png', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.tif', '.tiff'];

// RAW: nao e exibivel direto pelo navegador, mas todo CR2 carrega um JPEG de preview
// embutido - e por ele que a tela mostra a foto quando a camera esta em RAW-only.
const EXT_RAW_EXIBIVEL = ['.cr2', '.cr3', '.nef', '.arw', '.dng'];

function ehRawExibivel(nome) {
    return EXT_RAW_EXIBIVEL.includes(path.extname(nome).toLowerCase());
}

// Bytes JPEG pra mandar pra tela: JPG/PNG vao direto, RAW vem do preview embutido.
// Devolve null se for RAW sem preview legivel - quem chama pula a foto em vez de quebrar.
function bytesParaExibir(caminho) {
    if (!ehRawExibivel(caminho)) return fs.readFileSync(caminho);
    const preview = cr2Preview.extrairPreview(caminho);
    return preview.ok ? preview.buffer : null;
}

function nomeBase(nome) {
    const ext = path.extname(nome);
    return ext ? nome.slice(0, -ext.length) : nome;
}

// Lista os arquivos dentro de `pasta` que compartilham o nome-base de `nome` (mesma
// foto, extensoes diferentes: .jpg + .cr2). Case-insensitive. Vazio se a pasta nao existe.
function paresNaPasta(pasta, nome) {
    if (!fs.existsSync(pasta)) return [];
    const base = nomeBase(nome).toLowerCase();
    return fs.readdirSync(pasta).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return EXTENSOES_PAR.includes(ext) && nomeBase(f).toLowerCase() === base;
    });
}

// Apaga todos os arquivos-par (jpg + cr2 + ...) de `nome` dentro de `pasta`. Devolve os
// nomes removidos. Usado no delete pra nao deixar o RAW orfao quando o JPG e apagado.
function removerPares(pasta, nome) {
    const removidos = [];
    paresNaPasta(pasta, nome).forEach(f => {
        try { fs.unlinkSync(path.join(pasta, f)); removidos.push(f); } catch (err) { /* ignora */ }
    });
    return removidos;
}

// Instancia PROPRIA do syncIMG (copia do jar), rodando dentro do sphoto, so pra receber
// as fotos ja editadas de volta (bucket EditingDone) pra pasta local AguardandoQA - fecha
// o buraco que faltava no pipeline (ninguem recebia isso pra QA de Edicao ainda).
// ATENCAO: regra em SYNCIMG_RECEIVER_IMAGES_QA.json e uma HIPOTESE (Situacao "Aguardando
// QA Edição" -> "Em QA") baseada no padrao dos outros robos, nao confirmada ainda -
// validar/ajustar no primeiro recebimento real.
const SYNCIMG_QA_EDICAO_BASE = path.join(BASE_PATH, 'syncimg-qa-edicao');
const SYNCIMG_QA_EDICAO_BAT = 'iniciar-recebimento-qa.bat';
const AGUARDANDO_QA_BASE = path.join(BASE_PATH, 'AguardandoQA');

// Robo real que envia pro editor (C:\SyncIMGSend\AgEnvio -> bucket WaitingEditing) - so
// pega o GTIN se a Situacao das Imagens estiver "Em Conferência" (155), ai ele mesmo muda
// pra "Aguardando Edição" (20). Ver SYNCIMG_SEND_IMAGES_NOVO.json. Por isso so disparamos
// essa copia quando o "Confirmar e enviar" da aba QA para Edicao grava justamente 155 -
// fecha o elo entre a aprovacao do QA de fotografia e o envio pro editor.
const SYNCIMGSEND_BASE = 'C:\\SyncIMGSend';
const SYNCIMGSEND_AGENVIO = path.join(SYNCIMGSEND_BASE, 'AgEnvio');
const SYNCIMGSEND_BAT = 'start.bat';

// IDs de custom_fields do Redmine (ver c:\sphoto\redmine-campos.json)
const CF = {
    GTIN: 1,
    OS: 2,
    SITUACAO_IMAGENS: 15,
    DATA_FOTOGRAFIA: 19,
    RESPONSAVEL_POS_PRODUCAO: 23,
    PREVISAO_ENTREGA_POS_PRODUCAO: 34,
    QTD_IMAGENS_MOCKUP: 175,
    QTD_IMAGENS_RECORTE: 176,
    QTD_IMAGENS_ENVIADAS_EDICAO: 83
};
const OPCAO_AGUARDANDO_QA_FOTOGRAFIA = '19';
const OPCAO_EM_CONFERENCIA = '155';
const OPCAO_BRIGHT_RIVER = '258';
const OPCAO_VIRA_FILMES = '32';
const OPCAO_EM_EDICAO = '85';

function isNomeSeguro(valor) {
    return typeof valor === 'string' && valor.length > 0 &&
        !valor.includes('..') && !valor.includes('/') && !valor.includes('\\');
}

function isSufixoSeguro(valor) {
    return typeof valor === 'string' && /^_[a-zA-Z0-9]+$/.test(valor);
}

function lerCorpo(req) {
    return new Promise((resolve, reject) => {
        let dados = '';
        req.on('data', chunk => { dados += chunk; });
        req.on('end', () => resolve(dados));
        req.on('error', reject);
    });
}

function enviarJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function carregarConfigRedmine() {
    const configPath = path.join(BASE_PATH, 'redmine-config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error('redmine-config.json nao encontrado em ' + BASE_PATH);
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// TERMINAIS (estacao do fotografo): o QA trabalha direto no lado do arquivo DE VERDADE -
// Finalizadas\OS_<os>\<gtin> - que e onde o RAW (.cr2) cai e de onde a entrega (AgEnvio) sai.
//
// Historico, pra ninguem "consertar" isso de volta: por um tempo o QA daqui leu a pasta
// OCR\OS_<os>\<gtin> (o JPG da captura), porque o CR2 nao era exibivel e um GTIN so com RAW
// sumia da lista. Isso quebrou quando a camera foi pra RAW-only: nesse modo NAO existe JPG,
// o salvarImagens manda tudo pro lado RAW e a pasta OCR fica vazia -> QA vazio de novo.
// A correcao de verdade era exibir o RAW (ver lib/cr2Preview.js), nao trocar de pasta.
// Hoje o preview embutido do CR2 tem ~1,7 MB contra ~20 MB do JPG da camera - ler daqui e
// mais leve nos dois modos.
//
// O lado OCR virou o espelho: existe quando a camera grava JPG, e todo comando do QA
// (subpasta, sufixo, destino) e replicado la via pastaGtinOcr(). Em RAW-only ele fica vazio
// e os espelhamentos viram no-op sozinhos.
function pastaGtin(os, gtin) {
    return path.join(PASTA_FINALIZADAS, 'OS_' + os, gtin);
}

// Pasta gemea do JPG da captura (espelho). Vazia/inexistente quando a camera esta em RAW-only.
function pastaGtinOcr(os, gtin) {
    return path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + os, gtin);
}

function listarSubpastasFisicas(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(nome => fs.statSync(path.join(dir, nome)).isDirectory());
}

// Fotos exibiveis na raiz do GTIN. Aceita RAW porque com a camera em RAW-only nao existe
// JPG nenhum - e o GTIN sumia da lista do QA como se nao tivesse sido fotografado.
// Se o par jpg+cr2 existir, conta so uma vez (pelo nome-base), senao a mesma foto apareceria
// duplicada na tela.
function listarJpgsRaiz(pasta) {
    if (!fs.existsSync(pasta)) return [];
    const arquivos = fs.readdirSync(pasta)
        .filter(nome => fs.statSync(path.join(pasta, nome)).isFile())
        .filter(nome => /\.(jpg|jpeg)$/i.test(nome) || ehRawExibivel(nome))
        // JPG antes do RAW: se a foto tiver os dois, e o JPG que fica (ja e imagem pronta,
        // nao precisa extrair preview).
        .sort((a, b) => (ehRawExibivel(a) ? 1 : 0) - (ehRawExibivel(b) ? 1 : 0));

    const vistos = new Set();
    return arquivos.filter(nome => {
        const base = nomeBase(nome).toLowerCase();
        if (vistos.has(base)) return false;
        vistos.add(base);
        return true;
    });
}

function temSufixo(nome, sufixo) {
    const ext = path.extname(nome);
    const semExt = nome.slice(0, -ext.length);
    return semExt.endsWith(sufixo);
}

function jaEnviado(pastaGtinPath) {
    return fs.existsSync(path.join(pastaGtinPath, MARCADOR_ENVIADO));
}

// Deriva os defaults dos campos do Redmine a partir do que existe na pasta do GTIN.
// Tudo aqui e so sugestao - o usuario pode sobrescrever na tela antes de confirmar.
function inferirCampos(pastaGtinPath) {
    const subpastas = detectarSubpastasDestino(pastaGtinPath);
    const arquivosRaiz = listarJpgsRaiz(pastaGtinPath);

    if (subpastas.temMockup && subpastas.temRecorte) {
        return { destino: 'indefinido', motivo: 'Pasta tem subpasta Mockup e Recorte ao mesmo tempo', campos: {} };
    }

    // Mockup e o unico sinal certo de Brasil (Virafilme) - nunca vai pra EUA.
    if (subpastas.temMockup) {
        const campos = {};
        campos[CF.QTD_IMAGENS_MOCKUP] = String(arquivosRaiz.length);
        campos[CF.SITUACAO_IMAGENS] = OPCAO_EM_CONFERENCIA;
        campos[CF.RESPONSAVEL_POS_PRODUCAO] = OPCAO_VIRA_FILMES;
        return { destino: 'brasil', campos };
    }

    // Recorte sozinho (sem Mockup) - por padrao Bright River, mas o campo Responsavel
    // continua livre pra trocar na tela (os criterios de qual demanda de recorte vai
    // pra qual vendor ainda estao sendo definidos - so Mockup e certeza de Brasil).
    if (subpastas.temRecorte) {
        const campos = {};
        campos[CF.QTD_IMAGENS_RECORTE] = String(arquivosRaiz.length);
        campos[CF.SITUACAO_IMAGENS] = OPCAO_EM_CONFERENCIA;
        campos[CF.RESPONSAVEL_POS_PRODUCAO] = OPCAO_BRIGHT_RIVER;
        return { destino: 'eua', campos };
    }

    const semCoding = arquivosRaiz.filter(nome => !temSufixo(nome, '_coding'));
    const comCoding = arquivosRaiz.filter(nome => temSufixo(nome, '_coding'));

    // Sem subpasta (Mockup/Recorte) e sem nenhuma _coding, nao ha sinal nenhum de pra
    // onde vai - fica em aberto pro QA de Edicao decidir na mao (fotografo pode nao ter
    // setado nada no sphoto, o QA e quem fecha a separacao).
    if (comCoding.length === 0) {
        return {
            destino: 'indefinido',
            motivo: 'Pasta sem subpasta Mockup/Recorte e sem nenhuma foto marcada com _coding - sem sinal de destino',
            campos: {}
        };
    }

    const campos = {};
    campos[CF.QTD_IMAGENS_RECORTE] = String(semCoding.length);
    campos[CF.SITUACAO_IMAGENS] = OPCAO_EM_CONFERENCIA;
    campos[CF.RESPONSAVEL_POS_PRODUCAO] = OPCAO_BRIGHT_RIVER;
    return { destino: 'eua', campos };
}

// So Mockup/Recorte decidem o destino EUA/Brasil - RT/IS/AP sao organizacao interna
// (aba QA de Foto) e nao contam pra essa inferencia.
function detectarSubpastasDestino(pastaGtinPath) {
    const existentes = listarSubpastasFisicas(pastaGtinPath);
    return {
        temMockup: existentes.includes('Mockup'),
        temRecorte: existentes.includes('Recorte'),
        existentes
    };
}

// Le o conteudo das subpastas indicadas (RT/IS/AP e/ou Mockup/Recorte) dentro de uma
// pasta de GTIN - reaproveitada pela QA Hub (pasta RAW) e pelo endpoint de subpastas
// do server.js (pasta OCR, usado pelo index.html).
function listarArquivosDeSubpastas(pastaBase, tags) {
    const subpastas = {};
    tags.forEach(tag => {
        const pastaTag = path.join(pastaBase, tag);
        if (fs.existsSync(pastaTag)) {
            subpastas[tag] = listarJpgsRaiz(pastaTag)
                .map(nome => {
                    // Idem raiz: RAW entra pelo preview embutido.
                    const bytes = bytesParaExibir(path.join(pastaTag, nome));
                    return bytes ? { nome, arquivo: bytes.toString('base64') } : null;
                })
                .filter(Boolean);
        }
    });
    return subpastas;
}

function listarImagensComTags(pastaGtinPath) {
    const arquivosRaiz = listarJpgsRaiz(pastaGtinPath);
    const imagensRaiz = arquivosRaiz
        .map(nome => {
            // RAW vai pra tela pelo preview embutido (camera em RAW-only nao gera JPG).
            const bytes = bytesParaExibir(path.join(pastaGtinPath, nome));
            return bytes ? { nome, arquivo: bytes.toString('base64'), temCoding: temSufixo(nome, '_coding') } : null;
        })
        .filter(Boolean);

    const subpastas = listarArquivosDeSubpastas(pastaGtinPath, SUBPASTAS_TAG.concat(SUBPASTAS_DESTINO));

    return { raiz: imagensRaiz, subpastas };
}

function escanearArvore() {
    const resultado = [];
    const osDirs = listarSubpastasFisicas(PASTA_FINALIZADAS)
        .filter(nome => nome.startsWith('OS_') && nome !== 'OS_NONE');

    osDirs.forEach(nomeOsDir => {
        const os = nomeOsDir.slice('OS_'.length);
        const osPath = path.join(PASTA_FINALIZADAS, nomeOsDir);
        const gtins = listarSubpastasFisicas(osPath);
        const gtinsPendentes = [];

        gtins.forEach(gtin => {
            const pastaAtual = pastaGtin(os, gtin);
            if (jaEnviado(pastaAtual)) return;

            // Sem nenhum JPG final na raiz (Lightroom ainda nao exportou), nao ha nada
            // pronto pra revisar ainda - nao mostra na lista (senao aparece com destino/
            // contagem zerados, dando a falsa impressao de que ja esta pronto pra enviar).
            if (listarJpgsRaiz(pastaAtual).length === 0) return;

            const inferido = inferirCampos(pastaAtual);
            gtinsPendentes.push({
                gtin,
                qtdArquivosRaiz: listarJpgsRaiz(pastaAtual).length,
                subpastas: detectarSubpastasDestino(pastaAtual).existentes,
                destinoInferido: inferido.destino
            });
        });

        if (gtinsPendentes.length > 0) {
            resultado.push({ os, gtins: gtinsPendentes });
        }
    });

    return resultado;
}

// --- Redmine REST ----------------------------------------------------------

async function redmineFetch(caminho, opcoes) {
    const config = carregarConfigRedmine();
    const cabecalhos = Object.assign({
        'X-Redmine-API-Key': config.apiKey,
        'Content-Type': 'application/json'
    }, (opcoes && opcoes.headers) || {});
    return fetch(config.baseUrl + caminho, Object.assign({}, opcoes, { headers: cabecalhos }));
}

async function buscarIssueAbertaPorGtin(gtin) {
    const resp = await redmineFetch('/issues.json?cf_1=' + encodeURIComponent(gtin) + '&status_id=open&tracker_id=2&limit=5');
    if (!resp.ok) throw new Error('Redmine respondeu ' + resp.status + ' ao buscar GTIN ' + gtin);
    const dados = await resp.json();
    if (!dados.issues || dados.issues.length === 0) return null;
    return dados.issues[0];
}

async function buscarIssueCompleta(issueId) {
    const resp = await redmineFetch('/issues/' + issueId + '.json');
    if (!resp.ok) throw new Error('Redmine respondeu ' + resp.status + ' ao buscar issue ' + issueId);
    const dados = await resp.json();
    return dados.issue;
}

function valorCf(issue, id) {
    const campo = issue.custom_fields.find(c => c.id === id);
    return campo ? campo.value : '';
}

function hojeISO() {
    const agora = new Date();
    return agora.getFullYear() + '-' + String(agora.getMonth() + 1).padStart(2, '0') + '-' + String(agora.getDate()).padStart(2, '0');
}

// Todas as issues GTIN abertas com Situacao das Imagens = Em Edicao, pra agenda de
// edicao (aba nova do QA Hub). Pagina de 100 em 100 (limite do Redmine por request),
// ate um teto de seguranca, caso a base cresca muito.
async function buscarIssuesEmEdicao() {
    const PAGINA = 100;
    const TETO_PAGINAS = 10;
    let resultado = [];

    for (let pagina = 0; pagina < TETO_PAGINAS; pagina++) {
        const resp = await redmineFetch('/issues.json?tracker_id=2&status_id=open&cf_15=' + OPCAO_EM_EDICAO +
            '&limit=' + PAGINA + '&offset=' + (pagina * PAGINA));
        if (!resp.ok) throw new Error('Redmine respondeu ' + resp.status + ' ao buscar issues em edicao');
        const dados = await resp.json();
        resultado = resultado.concat(dados.issues || []);
        if (resultado.length >= dados.total_count || !dados.issues || dados.issues.length === 0) break;
    }

    return resultado;
}

// Deriva as colunas da agenda de edicao a partir de uma issue Redmine (GTIN) - previsao
// de entrega usa o campo dedicado da pos-producao quando preenchido, senao cai pro prazo
// geral da issue (due_date, quase sempre preenchido), e sem previsao nenhuma quando
// nenhum dos dois existir.
function montarItemAgenda(issue) {
    const gtin = valorCf(issue, CF.GTIN) || issue.subject.split(' - ')[0];
    const produto = issue.subject.startsWith(gtin) ? issue.subject.slice(gtin.length + 3) : issue.subject;
    const qtdRecorte = Number(valorCf(issue, CF.QTD_IMAGENS_RECORTE)) || 0;
    const qtdMockup = Number(valorCf(issue, CF.QTD_IMAGENS_MOCKUP)) || 0;
    // Na fase "Em Edicao" a quebra Recorte/Mockup normalmente ainda nao foi preenchida
    // (so e feita depois, na conferencia) - o total real disponivel aqui e o que foi
    // de fato enviado pra edicao (cf_83). Cai pra soma recorte+mockup so se cf_83 vier
    // vazio por algum motivo.
    const qtdEnviadasEdicao = Number(valorCf(issue, CF.QTD_IMAGENS_ENVIADAS_EDICAO)) || 0;

    const previsaoPosProducao = valorCf(issue, CF.PREVISAO_ENTREGA_POS_PRODUCAO);
    const previsaoEntrega = previsaoPosProducao || issue.due_date || null;
    const origemPrevisao = previsaoPosProducao ? 'pos_producao' : (issue.due_date ? 'prazo_geral' : null);

    return {
        issueId: issue.id,
        gtin,
        produto,
        os: valorCf(issue, CF.OS) || null,
        totalFotos: qtdEnviadasEdicao || (qtdRecorte + qtdMockup),
        previsaoEntrega,
        origemPrevisao,
        updatedOn: issue.updated_on
    };
}

async function montarAgendaEdicao() {
    const issues = await buscarIssuesEmEdicao();
    const hoje = hojeISO();

    return issues
        .map(montarItemAgenda)
        // Regra combinada: mostra tudo que nao tem previsao nenhuma (nao da pra saber se
        // esta atrasado ou nao) + tudo com previsao de hoje em diante. O que ja passou do
        // dia atual sai da agenda.
        .filter(item => !item.previsaoEntrega || item.previsaoEntrega >= hoje)
        .sort((a, b) => {
            if (!a.previsaoEntrega && !b.previsaoEntrega) return 0;
            if (!a.previsaoEntrega) return 1;
            if (!b.previsaoEntrega) return -1;
            return a.previsaoEntrega < b.previsaoEntrega ? -1 : 1;
        });
}

// --- Handlers ----------------------------------------------------------

// As pastas que o robo de recebimento cria vem decoradas (ex.: "OS_49800---(3 GTINs)---
// 2026-07-20", "7898994680758---(4 imagens)---2026-07-20"), entao localizamos pelo
// prefixo numerico em vez do nome exato.
function localizarPastaDecoradaPorPrefixo(baseDir, prefixoAlvo, prefixoRegex) {
    if (!fs.existsSync(baseDir)) return null;
    const candidatos = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(entrada => entrada.isDirectory())
        .map(entrada => entrada.name);
    return candidatos.find(nome => {
        const m = nome.match(prefixoRegex);
        return m && m[1] === prefixoAlvo;
    }) || null;
}

// Fotos ja editadas, recebidas de volta do editor (bucket EditingDone) pela instancia
// propria do syncIMG que roda dentro do sphoto - ver SYNCIMG_QA_EDICAO_BASE. So lista
// nome/contagem por enquanto (TIFF nao renderiza em <img>, sem ImageMagick disponivel
// nesta maquina pra gerar thumbnail).
function buscarImagensEditadasRecebidas(os, gtin) {
    const pastaOsNome = localizarPastaDecoradaPorPrefixo(AGUARDANDO_QA_BASE, os, /^OS_(\d+)/);
    if (!pastaOsNome) return null;
    const pastaOsPath = path.join(AGUARDANDO_QA_BASE, pastaOsNome);

    const pastaGtinNome = localizarPastaDecoradaPorPrefixo(pastaOsPath, gtin, /^(\d+)/);
    if (!pastaGtinNome) return null;
    const pastaGtinPath = path.join(pastaOsPath, pastaGtinNome);

    const arquivos = fs.readdirSync(pastaGtinPath, { withFileTypes: true })
        .filter(entrada => entrada.isFile())
        .map(entrada => entrada.name);

    return { pastaNome: pastaGtinNome, arquivos };
}

function iniciarRecebimentoQaEdicaoDesanexado() {
    const processo = spawn('cmd.exe', ['/c', 'start', '""', SYNCIMG_QA_EDICAO_BAT], {
        cwd: SYNCIMG_QA_EDICAO_BASE,
        detached: true,
        stdio: 'ignore'
    });
    processo.unref();
}

// Trava de seguranca - desligada enquanto o ambiente de teste nao estiver pronto,
// pra nao arriscar baixar (e mover/apagar) algo que esteja em andamento real no bucket
// EditingDone. Reativar (true) so depois de confirmar o ambiente de teste.
const RECEBIMENTO_QA_EDICAO_HABILITADO = false;

async function handleIniciarRecebimentoQaEdicao(req, res) {
    if (!RECEBIMENTO_QA_EDICAO_HABILITADO) {
        return enviarJson(res, 403, { ok: false, error: 'Recebimento desativado por segurança - ver RECEBIMENTO_QA_EDICAO_HABILITADO em lib/qaHub.js' });
    }
    if (!fs.existsSync(SYNCIMG_QA_EDICAO_BASE)) {
        return enviarJson(res, 500, { ok: false, error: 'Instancia nao encontrada em ' + SYNCIMG_QA_EDICAO_BASE });
    }
    try {
        iniciarRecebimentoQaEdicaoDesanexado();
        enviarJson(res, 200, { ok: true });
    } catch (err) {
        console.error('Erro ao iniciar robo de recebimento QA de Edicao:', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

async function handleGetGtin(req, res, query) {
    const os = query.get('os') || '';
    const gtin = query.get('gtin') || '';
    if (!isNomeSeguro(os) || !isNomeSeguro(gtin)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametros os/gtin invalidos' });
    }

    const pastaAtual = pastaGtin(os, gtin);
    if (!fs.existsSync(pastaAtual)) {
        return enviarJson(res, 404, { ok: false, error: 'Pasta nao encontrada: ' + pastaAtual });
    }

    const imagens = listarImagensComTags(pastaAtual);
    const inferido = inferirCampos(pastaAtual);

    let issueResumo = null;
    try {
        const issue = await buscarIssueAbertaPorGtin(gtin);
        if (issue) {
            const completa = await buscarIssueCompleta(issue.id);
            issueResumo = {
                id: completa.id,
                subject: completa.subject,
                updated_on: completa.updated_on,
                custom_fields: completa.custom_fields
            };
        }
    } catch (err) {
        console.error('Erro ao consultar Redmine para GTIN', gtin, err);
    }

    enviarJson(res, 200, {
        ok: true,
        os,
        gtin,
        enviado: jaEnviado(pastaAtual),
        enviadoConferencia: fs.existsSync(path.join(SYNCIMG_ENVIADAS, 'OS_' + os, gtin)),
        editadasRecebidas: buscarImagensEditadasRecebidas(os, gtin),
        destinoInferido: inferido.destino,
        motivoIndefinido: inferido.motivo || null,
        camposSugeridos: inferido.campos,
        imagens,
        issue: issueResumo
    });
}

// Copia (nao move - a pasta local em Finalizadas continua intacta) os arquivos que o
// robo Syncimg sabe processar pra dentro de Fotografados\AgEnvio\OS_x\gtin, preservando
// subpastas (RT/IS/AP/Mockup/Recorte). O proprio robo depois move o que ele processar
// de AgEnvio pra Enviadas.
function copiarParaAgEnvio(origem, destino) {
    fs.mkdirSync(destino, { recursive: true });
    fs.readdirSync(origem, { withFileTypes: true }).forEach(entrada => {
        const origemItem = path.join(origem, entrada.name);
        const destinoItem = path.join(destino, entrada.name);
        if (entrada.isDirectory()) {
            copiarParaAgEnvio(origemItem, destinoItem);
        } else if (EXTENSOES_ENVIO_CONFERENCIA.includes(path.extname(entrada.name).toLowerCase())) {
            fs.copyFileSync(origemItem, destinoItem);
        }
    });
}

function iniciarSyncImgDesanexado() {
    const processo = spawn('cmd.exe', ['/c', 'start', '""', SYNCIMG_BAT], {
        cwd: SYNCIMG_BASE,
        detached: true,
        stdio: 'ignore'
    });
    processo.unref();
}

function iniciarSyncImgSendDesanexado() {
    const processo = spawn('cmd.exe', ['/c', 'start', '""', SYNCIMGSEND_BAT], {
        cwd: SYNCIMGSEND_BASE,
        detached: true,
        stdio: 'ignore'
    });
    processo.unref();
}

// Copia a pasta do GTIN pro AgEnvio do SyncIMGSend (robo real, C:\SyncIMGSend) e aciona
// o robo de la, fechando o elo "QA de fotografia aprovou -> vai pro editor". So chamado
// quando o "Confirmar e enviar" grava Situacao = Em Conferência (ver handleRedmineWrite).
// Falha aqui NAO derruba o retorno do Confirmar e enviar - o Redmine ja foi gravado com
// sucesso, isso e so o proximo elo; se der erro, so loga e quem usa o QA Hub ainda pode
// disparar de novo depois (ou fazer manualmente).
function encaminharParaSyncImgSend(os, gtin) {
    try {
        if (!fs.existsSync(SYNCIMGSEND_BASE)) {
            console.error('SyncIMGSend nao encontrado em', SYNCIMGSEND_BASE, '- pulei o encaminhamento');
            return;
        }
        const origemPath = pastaGtin(os, gtin);
        const destinoPath = path.join(SYNCIMGSEND_AGENVIO, 'OS_' + os, gtin);
        copiarParaAgEnvio(origemPath, destinoPath);
        iniciarSyncImgSendDesanexado();
    } catch (err) {
        console.error('Erro ao encaminhar para SyncIMGSend (nao bloqueia o Confirmar e enviar):', err);
    }
}

async function handleEnviarConferencia(req, res) {
    const corpo = await lerCorpo(req);
    let dados;
    try {
        dados = JSON.parse(corpo);
    } catch (err) {
        return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }

    if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametros os/gtin invalidos' });
    }

    const origemPath = pastaGtin(dados.os, dados.gtin);
    if (!fs.existsSync(origemPath)) {
        return enviarJson(res, 404, { ok: false, error: 'Pasta nao encontrada: ' + origemPath });
    }
    if (!fs.existsSync(SYNCIMG_BASE)) {
        return enviarJson(res, 500, { ok: false, error: 'Robo Syncimg nao encontrado em ' + SYNCIMG_BASE });
    }

    const destinoPath = path.join(SYNCIMG_AGENVIO, 'OS_' + dados.os, dados.gtin);

    try {
        copiarParaAgEnvio(origemPath, destinoPath);
        iniciarSyncImgDesanexado();
        enviarJson(res, 200, { ok: true, copiadoPara: destinoPath });
    } catch (err) {
        console.error('Erro ao enviar para conferencia (SyncIMG):', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

// Versao em lote - na maior parte das vezes o fotografo termina a OS inteira e entrega
// tudo de uma vez (o botao por GTIN continua existindo pra quando ele divide o trabalho
// e entrega parcial). Copia todos os GTINs pendentes da OS (mesmo criterio do
// escanearArvore: nao enviado ainda + tem pelo menos 1 jpg na raiz) e aciona o robo uma
// unica vez no final.
async function handleEnviarConferenciaOs(req, res) {
    const corpo = await lerCorpo(req);
    let dados;
    try {
        dados = JSON.parse(corpo);
    } catch (err) {
        return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }

    if (!isNomeSeguro(dados.os)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametro os invalido' });
    }
    if (!fs.existsSync(SYNCIMG_BASE)) {
        return enviarJson(res, 500, { ok: false, error: 'Robo Syncimg nao encontrado em ' + SYNCIMG_BASE });
    }

    const osPath = path.join(PASTA_FINALIZADAS, 'OS_' + dados.os);
    if (!fs.existsSync(osPath)) {
        return enviarJson(res, 404, { ok: false, error: 'OS nao encontrada: ' + osPath });
    }

    const gtins = listarSubpastasFisicas(osPath).filter(gtin => {
        const pastaAtual = pastaGtin(dados.os, gtin);
        return !jaEnviado(pastaAtual) && listarJpgsRaiz(pastaAtual).length > 0;
    });

    if (gtins.length === 0) {
        return enviarJson(res, 200, { ok: true, gtinsCopiados: [] });
    }

    try {
        gtins.forEach(gtin => {
            const origemPath = pastaGtin(dados.os, gtin);
            const destinoPath = path.join(SYNCIMG_AGENVIO, 'OS_' + dados.os, gtin);
            copiarParaAgEnvio(origemPath, destinoPath);
        });
        iniciarSyncImgDesanexado();
        enviarJson(res, 200, { ok: true, gtinsCopiados: gtins });
    } catch (err) {
        console.error('Erro ao enviar OS inteira para conferencia:', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

// Move (ou desfaz) a marcacao RT/IS/AP de arquivos dentro de uma pasta de GTIN -
// reaproveitada tanto pela QA Hub (pasta Finalizadas\OS_x\gtin) quanto pelo endpoint
// /api/tag-subpasta do server.js (pasta Finalizadas\OCR\OS_x\gtin, usado pelo index.html).
function moverParaSubpasta(pastaBase, arquivos, pasta) {
    if (!SUBPASTAS_TAG.includes(pasta)) {
        throw new Error('Pasta deve ser RT, IS ou AP');
    }

    const movidos = {};
    const basesFeitas = new Set();

    arquivos.forEach(nome => {
        if (!isNomeSeguro(nome)) return;

        // Trata cada foto uma vez so, mesmo que jpg e cr2 venham juntos na lista.
        const base = nomeBase(nome).toLowerCase();
        if (basesFeitas.has(base)) return;
        basesFeitas.add(base);

        // Descobre onde o grupo (jpg + cr2 + ...) esta agora: raiz ou uma subpasta de tag.
        let pastaOrigemAtual; // undefined = nao achou; null = raiz; senao o nome do tag
        if (paresNaPasta(pastaBase, nome).length > 0) {
            pastaOrigemAtual = null;
        } else {
            for (const tag of SUBPASTAS_TAG) {
                if (paresNaPasta(path.join(pastaBase, tag), nome).length > 0) {
                    pastaOrigemAtual = tag;
                    break;
                }
            }
        }
        if (pastaOrigemAtual === undefined) return; // arquivo nao existe nessa pasta-base

        // Toggle: se ja esta na pasta pedida, volta pra raiz; senao, move pra la
        // (arquivo so pode estar em uma subpasta de tag por vez).
        const vaiParaRaiz = pastaOrigemAtual === pasta;
        const pastaOrigem = pastaOrigemAtual ? path.join(pastaBase, pastaOrigemAtual) : pastaBase;
        const pastaDestino = vaiParaRaiz ? pastaBase : path.join(pastaBase, pasta);

        if (!vaiParaRaiz) fs.mkdirSync(pastaDestino, { recursive: true });

        // Move o JPG e o RAW irmao juntos, preservando cada extensao.
        paresNaPasta(pastaOrigem, nome).forEach(f => {
            fs.renameSync(path.join(pastaOrigem, f), path.join(pastaDestino, f));
            movidos[f] = vaiParaRaiz ? 'raiz' : pasta;
        });
    });

    return movidos;
}

async function handleTagSubpasta(req, res) {
    const corpo = await lerCorpo(req);
    let dados;
    try {
        dados = JSON.parse(corpo);
    } catch (err) {
        return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }

    if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametros os/gtin invalidos' });
    }
    if (!SUBPASTAS_TAG.includes(dados.pasta)) {
        return enviarJson(res, 400, { ok: false, error: 'Pasta deve ser RT, IS ou AP' });
    }
    if (!Array.isArray(dados.arquivos) || dados.arquivos.length === 0) {
        return enviarJson(res, 400, { ok: false, error: 'Parametro arquivos invalido' });
    }

    try {
        const movidos = moverParaSubpasta(pastaGtin(dados.os, dados.gtin), dados.arquivos, dados.pasta);
        // Espelha no lado OCR (JPG da captura), quando existir: casa pelo nome-base, entao da
        // pra passar os nomes .cr2 mesmo a pasta de la so tendo .jpg. Em RAW-only vira no-op.
        const pastaOcr = pastaGtinOcr(dados.os, dados.gtin);
        if (fs.existsSync(pastaOcr)) {
            moverParaSubpasta(pastaOcr, dados.arquivos, dados.pasta);
        }
        enviarJson(res, 200, { ok: true, movidos });
    } catch (err) {
        console.error('Erro ao mover para subpasta:', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

// Remove a subpasta Mockup/Recorte se ela existir e estiver vazia (nunca apaga
// arquivo nenhum - se alguem colocou algo la manualmente, deixa quieto e avisa).
function removerSePastaVazia(pastaTag) {
    if (!fs.existsSync(pastaTag)) return null;
    const conteudo = fs.readdirSync(pastaTag);
    if (conteudo.length === 0) {
        fs.rmdirSync(pastaTag);
        return null;
    }
    return 'Pasta "' + path.basename(pastaTag) + '" nao estava vazia (' + conteudo.length + ' item(ns)) - nao foi removida.';
}

// Marca/desmarca manualmente o destino Brasil (Mockup ou Recorte) criando/removendo
// a subpasta correspondente - a mera existencia da pasta e o sinal que inferirCampos()
// usa, os arquivos continuam soltos na raiz do GTIN. tipo=null desmarca os dois.
async function handleMarcarDestino(req, res) {
    const corpo = await lerCorpo(req);
    let dados;
    try {
        dados = JSON.parse(corpo);
    } catch (err) {
        return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }

    if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametros os/gtin invalidos' });
    }
    if (dados.tipo !== null && !SUBPASTAS_DESTINO.includes(dados.tipo)) {
        return enviarJson(res, 400, { ok: false, error: 'tipo deve ser "Mockup", "Recorte" ou null' });
    }

    // Espelha o sinal de destino nas duas gemeas (RAW e o espelho OCR).
    const pastasGtin = [pastaGtin(dados.os, dados.gtin), pastaGtinOcr(dados.os, dados.gtin)];
    const avisos = [];

    try {
        pastasGtin.forEach((pastaGtinPath, idx) => {
            if (!fs.existsSync(pastaGtinPath)) return;
            SUBPASTAS_DESTINO.forEach(tag => {
                const pastaTag = path.join(pastaGtinPath, tag);
                if (dados.tipo === tag) {
                    if (!fs.existsSync(pastaTag)) fs.mkdirSync(pastaTag, { recursive: true });
                } else {
                    const aviso = removerSePastaVazia(pastaTag);
                    // Aviso so do lado do QA - o RAW gemeo repetiria a mesma mensagem.
                    if (aviso && idx === 0) avisos.push(aviso);
                }
            });
        });
        enviarJson(res, 200, { ok: true, avisos });
    } catch (err) {
        console.error('Erro ao marcar destino Mockup/Recorte:', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

async function handleMarcarQa(req, res) {
    const corpo = await lerCorpo(req);
    let dados;
    try {
        dados = JSON.parse(corpo);
    } catch (err) {
        return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }

    if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin) ||
        !Array.isArray(dados.arquivos) || dados.arquivos.length === 0 ||
        !isSufixoSeguro(dados.sufixo)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametros invalidos' });
    }

    // Lado do arquivo real (RAW) + o espelho OCR: o par recebe o mesmo sufixo, pra nao desparear.
    const pastasAlvo = [pastaGtin(dados.os, dados.gtin), pastaGtinOcr(dados.os, dados.gtin)];
    const renomeados = {};

    try {
        dados.arquivos.forEach(nome => {
            if (!isNomeSeguro(nome)) return;
            // Direcao do toggle decidida pelo arquivo pedido; aplicada ao par (jpg + cr2).
            const remover = nomeBase(nome).endsWith(dados.sufixo);
            pastasAlvo.forEach(pastaAlvo => paresNaPasta(pastaAlvo, nome).forEach(f => {
                const ext = path.extname(f);
                const semExt = f.slice(0, -ext.length);
                let novo = f;
                if (remover && semExt.endsWith(dados.sufixo)) {
                    novo = semExt.slice(0, -dados.sufixo.length) + ext;
                } else if (!remover && !semExt.endsWith(dados.sufixo)) {
                    novo = semExt + dados.sufixo + ext;
                }
                if (novo !== f) fs.renameSync(path.join(pastaAlvo, f), path.join(pastaAlvo, novo));
                renomeados[f] = novo;
            }));
        });
        enviarJson(res, 200, { ok: true, renomeados });
    } catch (err) {
        console.error('Erro ao marcar (QA Hub):', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

async function handleGetRedmineIssue(req, res, query) {
    const gtin = query.get('gtin') || '';
    if (!isNomeSeguro(gtin)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametro gtin invalido' });
    }
    try {
        const issue = await buscarIssueAbertaPorGtin(gtin);
        if (!issue) return enviarJson(res, 404, { ok: false, error: 'Nenhuma issue aberta encontrada para este GTIN' });
        const completa = await buscarIssueCompleta(issue.id);
        enviarJson(res, 200, { ok: true, issue: completa });
    } catch (err) {
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

// Fallback pro botao "Finalizar" do index.html (que so funciona com o start.jar/
// websocket rodando, via fotoEstudiougo.json) - grava direto via REST as mesmas duas
// coisas essenciais pro robo Syncimg poder pegar o GTIN: Situacao das Imagens ->
// "Aguardando QA Fotografia" e Data Fotografia -> hoje. Nao mexe no campo Fotografo
// (nao sabemos aqui quem tirou a foto, e quem clica isso no QA Hub pode nao ser o
// fotografo).
async function handleFinalizarGtin(req, res) {
    const corpo = await lerCorpo(req);
    let dados;
    try {
        dados = JSON.parse(corpo);
    } catch (err) {
        return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }

    if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametros os/gtin invalidos' });
    }

    try {
        const issue = await buscarIssueAbertaPorGtin(dados.gtin);
        if (!issue) return enviarJson(res, 404, { ok: false, error: 'Nenhuma ficha aberta encontrada no Redmine para este GTIN' });

        const customFields = [
            { id: CF.SITUACAO_IMAGENS, value: OPCAO_AGUARDANDO_QA_FOTOGRAFIA },
            { id: CF.DATA_FOTOGRAFIA, value: hojeISO() }
        ];

        const respPut = await redmineFetch('/issues/' + issue.id + '.json', {
            method: 'PUT',
            body: JSON.stringify({ issue: { custom_fields: customFields } })
        });

        if (!respPut.ok) {
            const texto = await respPut.text();
            throw new Error('Redmine respondeu ' + respPut.status + ': ' + texto);
        }

        enviarJson(res, 200, { ok: true });
    } catch (err) {
        console.error('Erro ao finalizar GTIN (fallback):', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

async function handleAgendaEdicao(req, res) {
    try {
        const itens = await montarAgendaEdicao();
        enviarJson(res, 200, { ok: true, itens, geradoEm: new Date().toISOString() });
    } catch (err) {
        console.error('Erro ao montar agenda de edicao:', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

async function handleRedmineWrite(req, res) {
    const corpo = await lerCorpo(req);
    let dados;
    try {
        dados = JSON.parse(corpo);
    } catch (err) {
        return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }

    if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin) || !dados.issueId || !dados.campos) {
        return enviarJson(res, 400, { ok: false, error: 'Parametros invalidos' });
    }

    try {
        const issueAtual = await buscarIssueCompleta(dados.issueId);

        if (dados.updatedOnConhecido && issueAtual.updated_on !== dados.updatedOnConhecido && !dados.forcar) {
            return enviarJson(res, 409, {
                ok: false,
                error: 'A ficha foi alterada no Redmine desde que esta tela foi aberta',
                issueAtual: { updated_on: issueAtual.updated_on, custom_fields: issueAtual.custom_fields }
            });
        }

        const customFields = Object.keys(dados.campos).map(id => ({ id: Number(id), value: dados.campos[id] }));

        const respPut = await redmineFetch('/issues/' + dados.issueId + '.json', {
            method: 'PUT',
            body: JSON.stringify({ issue: { custom_fields: customFields } })
        });

        if (!respPut.ok) {
            const texto = await respPut.text();
            throw new Error('Redmine respondeu ' + respPut.status + ': ' + texto);
        }

        const pastaGtinPath = pastaGtin(dados.os, dados.gtin);
        fs.writeFileSync(path.join(pastaGtinPath, MARCADOR_ENVIADO), JSON.stringify({
            enviadoEm: new Date().toISOString(),
            ferramenta: 'sphoto-qa-hub',
            os: dados.os,
            gtin: dados.gtin,
            issueId: dados.issueId,
            camposEnviados: dados.campos
        }, null, 2), 'utf8');

        // Fecha o elo pro editor: se o que acabou de ser gravado inclui Situacao =
        // "Em Conferência", e exatamente a senha que o SyncIMGSend real (C:\SyncIMGSend)
        // espera pra mandar pro editor - copia e aciona o robo de la.
        let encaminhadoParaEditor = false;
        if (String(dados.campos[CF.SITUACAO_IMAGENS]) === OPCAO_EM_CONFERENCIA) {
            encaminharParaSyncImgSend(dados.os, dados.gtin);
            encaminhadoParaEditor = true;
        }

        enviarJson(res, 200, { ok: true, encaminhadoParaEditor });
    } catch (err) {
        console.error('Erro ao escrever no Redmine:', err);
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

async function handleMarcarEnviado(req, res) {
    const corpo = await lerCorpo(req);
    let dados;
    try {
        dados = JSON.parse(corpo);
    } catch (err) {
        return enviarJson(res, 400, { ok: false, error: 'JSON invalido' });
    }
    if (!isNomeSeguro(dados.os) || !isNomeSeguro(dados.gtin)) {
        return enviarJson(res, 400, { ok: false, error: 'Parametros os/gtin invalidos' });
    }

    const marcadorPath = path.join(pastaGtin(dados.os, dados.gtin), MARCADOR_ENVIADO);

    try {
        if (dados.enviado === false) {
            if (fs.existsSync(marcadorPath)) fs.unlinkSync(marcadorPath);
        } else {
            fs.writeFileSync(marcadorPath, JSON.stringify({
                enviadoEm: new Date().toISOString(),
                ferramenta: 'sphoto-qa-hub',
                manual: true,
                os: dados.os,
                gtin: dados.gtin
            }, null, 2), 'utf8');
        }
        enviarJson(res, 200, { ok: true });
    } catch (err) {
        enviarJson(res, 500, { ok: false, error: err.message });
    }
}

// Roteador leve: retorna true se a rota foi tratada (a resposta pode terminar depois,
// de forma assincrona), false se a URL nao pertence a QA Hub.
function tratar(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/qa/tree') {
        try {
            enviarJson(res, 200, { ok: true, os: escanearArvore() });
        } catch (err) {
            console.error('Erro ao escanear arvore QA:', err);
            enviarJson(res, 500, { ok: false, error: err.message });
        }
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/qa/gtin') {
        handleGetGtin(req, res, url.searchParams);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/enviar-conferencia') {
        handleEnviarConferencia(req, res);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/enviar-conferencia-os') {
        handleEnviarConferenciaOs(req, res);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/iniciar-recebimento-qa-edicao') {
        handleIniciarRecebimentoQaEdicao(req, res);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/tag-subpasta') {
        handleTagSubpasta(req, res);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/marcar-destino') {
        handleMarcarDestino(req, res);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/marcar') {
        handleMarcarQa(req, res);
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/qa/redmine/issue') {
        handleGetRedmineIssue(req, res, url.searchParams);
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/qa/agenda-edicao') {
        handleAgendaEdicao(req, res);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/finalizar') {
        handleFinalizarGtin(req, res);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/redmine/write') {
        handleRedmineWrite(req, res);
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/qa/marcar-enviado') {
        handleMarcarEnviado(req, res);
        return true;
    }

    return false;
}

module.exports = { tratar, moverParaSubpasta, listarArquivosDeSubpastas, SUBPASTAS_TAG, isNomeSeguro, paresNaPasta, removerPares, nomeBase };
