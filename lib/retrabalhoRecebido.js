// Le o retrabalho recebido do QA de volta na maquina do fotografo - pasta que a regra
// RECEIVER do syncIMG.jar entrega em C:\SyncIMGSend\Retrabalho\<OS decorada>\<gtin>\,
// junto com Retrabalho_OS_<numero>.txt na raiz da pasta da OS (nao dentro da pasta do
// gtin - um TXT so serve todos os GTINs retrabalhados daquela OS). Ver
// docs/superpowers/specs/2026-07-29-tela-retrabalho-recebido-design.md.
const fs = require('fs');
const path = require('path');
const { localizarPastaDecoradaPorPrefixo } = require('./qaHub');

const SYNCIMGSEND_BASE = 'C:\\SyncIMGSend';
const RETRABALHO_BASE = path.join(SYNCIMGSEND_BASE, 'Retrabalho');

// Devolve { pastaGtinPath, motivos } se a pasta do GTIN existir dentro de Retrabalho, ou
// null se a pasta da OS ou do GTIN ainda nao existir - regra RECEIVER nao instalada ainda,
// ou retrabalho ainda nao chegou. Isso NAO e erro, e o estado normal na maioria do tempo
// (so existe pasta quando ha retrabalho pendente de verdade).
function buscarRetrabalhoRecebido(os, gtin) {
    const pastaOsNome = localizarPastaDecoradaPorPrefixo(RETRABALHO_BASE, os, /^OS_(\d+)/);
    if (!pastaOsNome) return null;
    const pastaOsPath = path.join(RETRABALHO_BASE, pastaOsNome);

    const pastaGtinNome = localizarPastaDecoradaPorPrefixo(pastaOsPath, gtin, /^(\d+)/);
    if (!pastaGtinNome) return null;
    const pastaGtinPath = path.join(pastaOsPath, pastaGtinNome);

    return { pastaGtinPath, motivos: lerMotivos(pastaOsPath, os, gtin) };
}

// Le Retrabalho_OS_<os>.txt (raiz da pasta da OS) e devolve so as linhas desse gtin, sem
// o prefixo "<gtin> - " (formato gerado por gerarLinhaTxt no Syndi_qa:
// "<gtin> - <arquivo>: <motivo1>, <motivo2>"). Falha de leitura (TXT ausente, corrompido,
// sem permissao) devolve lista vazia em vez de lancar - o fotografo ainda ve as fotos
// mesmo sem o texto dos motivos, nunca quebra a tela por causa disso.
function lerMotivos(pastaOsPath, os, gtin) {
    const caminhoTxt = path.join(pastaOsPath, `Retrabalho_OS_${os}.txt`);
    if (!fs.existsSync(caminhoTxt)) return [];
    try {
        const linhas = fs.readFileSync(caminhoTxt, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        const prefixo = gtin + ' - ';
        return linhas.filter(l => l.startsWith(prefixo)).map(l => l.slice(prefixo.length));
    } catch (err) {
        console.error('Erro ao ler TXT de retrabalho', caminhoTxt, err);
        return [];
    }
}

module.exports = { buscarRetrabalhoRecebido };
