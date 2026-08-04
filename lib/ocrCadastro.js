// Gera os JPG de OCR - do preview embutido do CR2 quando ha RAW, ou recomprimindo o
// proprio JPG quando a foto e orfa (camera sem RAW) - e copia pra pasta do Cadastro.
//
// Divisao de responsabilidade (decidida junto com o Ugo, e igual ao que o QA Hub ja faz
// com o AgEnvio): o sphoto SO gera o arquivo e copia. Quem escreve no Redmine e o robo do
// Cadastro, que roda em outra maquina, ja funciona, e so pega o GTIN se 'Foto (OCR)' estiver
// em 'Aguardando Inicio' - ai ele mesmo muda pra 'Concluido' DEPOIS de subir. Quem entrega e
// dono do status. Se a gente marcasse 'Concluido' aqui na hora de copiar, o Redmine mentiria
// sempre que o robo estivesse parado ou a rede caisse.
//
// De onde sai a imagem: do preview JPEG que ja vem embutido no CR2 (ver lib/cr2Preview.js) -
// mesma resolucao do JPG da camera e ~12x mais leve. Se a extracao falhar (camera de outro
// modelo), cai no JPG da camera em Finalizadas\OCR\... como fallback, em vez de quebrar.

const fs = require('fs');
const path = require('path');
const { extrairPreview } = require('./cr2Preview');
const { recomprimirParaOcr } = require('./imagemOcr');

const BASE_PATH = path.join(__dirname, '..');
const PASTA_FINALIZADAS = path.join(BASE_PATH, 'Finalizadas');
const CONFIG_PATH = path.join(BASE_PATH, 'ocr-config.json');

const EXT_RAW = ['.cr2', '.cr3', '.nef', '.arw', '.dng'];
const SUBPASTAS_TAG = ['RT', 'IS', 'AP'];

// Marca de "esta foto vira JPG pro Cadastro". E um SUFIXO no nome (igual ao _coding), nao uma
// subpasta - de proposito: subpasta (RT/IS/AP) e exclusiva, o arquivo so fica numa por vez, e a
// mesma foto pode ser de edicao E de OCR ao mesmo tempo. Como sufixo, as duas coisas convivem:
// o RT diz onde o arquivo mora no Finalizadas, o _ocr diz se gera jpg pro Cadastro (que e plano).
const SUFIXO_OCR = '_ocr';

// Config so ajusta a copia OPCIONAL pra rede. O destino principal (estrutura OCR local) nao
// e configuravel de proposito: e a mesma pasta que a camera alimentava quando gravava JPG,
// e nao pode depender de arquivo de config nem de rede pra funcionar.
// Tambem aceita qualidadeJpgOcr (numero, 0-100, padrao 75 se ausente) - usado ao recomprimir
// um JPG orfao (sem RAW par) pro padrao OCR, ver lib/imagemOcr.js.
function carregarConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        // Config quebrado NAO pode impedir o OCR de ser gerado - so desliga a copia pra rede.
        console.error('ocr-config.json invalido (' + err.message + ') - seguindo so com o OCR local');
        return {};
    }
}

// Estrutura OCR nativa: Finalizadas\OCR\OS_<os>\<gtin>[\<subpasta>]. E aqui que o JPG de OCR
// mora, igual no tempo em que a camera gerava o JPG sozinha.
function pastaOcrDestino(os, gtin, subpasta) {
    const base = path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + os, gtin);
    return subpasta ? path.join(base, subpasta) : base;
}

function nomeBase(nome) {
    const ext = path.extname(nome);
    return ext ? nome.slice(0, -ext.length) : nome;
}

function ehRaw(nome) {
    return EXT_RAW.includes(path.extname(nome).toLowerCase());
}

function temMarcaOcr(nome) {
    return nomeBase(nome).toLowerCase().endsWith(SUFIXO_OCR);
}

// Lista as fontes de OCR do GTIN, na raiz e nas subpastas de tag: RAW (extrai preview
// embutido) e JPG orfao (sem RAW de mesmo nome-base na mesma pasta - camera sem RAW).
// Quando o par jpg+cr2 existe, o RAW continua sendo a fonte preferida (igual sempre foi)
// e o JPG do par NAO entra aqui, pra nao gerar OCR duplicado da mesma foto.
// Devolve [{ caminho, nome, subpasta, tipo: 'raw'|'jpg' }].
function listarFontesOcr(os, gtin) {
    const pastaRaw = path.join(PASTA_FINALIZADAS, 'OS_' + os, gtin);
    if (!fs.existsSync(pastaRaw)) return [];

    const achados = [];
    const varrer = (dir, subpasta) => {
        if (!fs.existsSync(dir)) return;
        const nomes = fs.readdirSync(dir).filter(nome => fs.statSync(path.join(dir, nome)).isFile());
        const basesRaw = new Set(nomes.filter(ehRaw).map(n => nomeBase(n).toLowerCase()));

        nomes.forEach(nome => {
            if (ehRaw(nome)) {
                achados.push({ caminho: path.join(dir, nome), nome, subpasta, tipo: 'raw' });
            } else if (/\.jpe?g$/i.test(nome) && !basesRaw.has(nomeBase(nome).toLowerCase())) {
                achados.push({ caminho: path.join(dir, nome), nome, subpasta, tipo: 'jpg' });
            }
        });
    };
    varrer(pastaRaw, null);
    SUBPASTAS_TAG.forEach(tag => varrer(path.join(pastaRaw, tag), tag));
    return achados;
}

// Fallback: o JPG que a camera gerou, do lado OCR, mesmo nome-base.
function acharJpgDaCamera(os, gtin, base, subpasta) {
    const pastaOcr = path.join(PASTA_FINALIZADAS, 'OCR', 'OS_' + os, gtin);
    const dir = subpasta ? path.join(pastaOcr, subpasta) : pastaOcr;
    if (!fs.existsSync(dir)) return null;
    const alvo = fs.readdirSync(dir).find(f =>
        nomeBase(f).toLowerCase() === base.toLowerCase() && /\.jpe?g$/i.test(f));
    return alvo ? path.join(dir, alvo) : null;
}

// Copia pro Cadastro (pasta de rede). Best-effort: se a rede estiver fora, o OCR local ja
// foi gerado e nao se perde nada - da pra recopiar depois.
//
// Mas best-effort NAO pode ser mudo: devolve o que aconteceu pra tela poder dizer. Antes isso
// so caia num console.error que ninguem le, e o fotografo via "OCR gerado" achando que tinha
// ido pro Cadastro. Se a rede cair, ele TEM que ficar sabendo na hora.
function copiarParaCadastro(config, os, gtin, subpasta, arquivoOrigem, nomeSaida) {
    if (!config.pastaCadastro) return { estado: 'desligado' };
    try {
        let destino = config.pastaCadastro;
        if (config.criarPastaOs) destino = path.join(destino, 'OS_' + os);
        destino = path.join(destino, gtin);
        if (config.espelharSubpastas && subpasta) destino = path.join(destino, subpasta);
        fs.mkdirSync(destino, { recursive: true });
        fs.copyFileSync(arquivoOrigem, path.join(destino, nomeSaida));
        return { estado: 'copiado', destino };
    } catch (err) {
        console.error('Copia pro Cadastro falhou (o OCR local ja foi gerado):', err.message);
        return { estado: 'falhou', motivo: err.message };
    }
}

// Gera o JPG de OCR de um GTIN e copia pro Cadastro.
//   arquivos: opcional. Nomes (jpg ou cr2) pra gerar so os escolhidos; vazio/ausente = todos.
//   config:   opcional, pra teste. Ausente = le o ocr-config.json.
// Devolve { ok, destino, gerados: [...], falhas: [...] }.
async function gerarOcr(os, gtin, arquivos, config) {
    const cfg = config || carregarConfig();
    const fontes = listarFontesOcr(os, gtin);

    if (fontes.length === 0) {
        return { ok: false, erro: 'Nenhuma foto (RAW ou JPG) encontrada em Finalizadas\\OS_' + os + '\\' + gtin, gerados: [], falhas: [] };
    }

    // Se veio lista, filtra pelo nome-base (assim da pra mandar nomes .jpg da tela).
    let alvos = fontes;
    if (Array.isArray(arquivos) && arquivos.length > 0) {
        const bases = new Set(arquivos.map(a => nomeBase(a).toLowerCase()));
        alvos = fontes.filter(f => bases.has(nomeBase(f.nome).toLowerCase()));
        if (alvos.length === 0) {
            return { ok: false, erro: 'Nenhuma foto casou com os arquivos pedidos', gerados: [], falhas: [] };
        }
    } else {
        // Sem lista explicita, vale a marcacao: se o fotografo marcou alguma foto com _ocr,
        // ele quis escolher - gera SO essas. Nenhuma marcada = ele quer o GTIN inteiro
        // (o caso comum do checkbox OCR ligado, que e quando o OCR precisa de varias fotos).
        const marcadas = fontes.filter(f => temMarcaOcr(f.nome));
        if (marcadas.length > 0) alvos = marcadas;
    }

    const gerados = [];
    const falhas = [];
    // Resumo da copia pra rede, pra tela poder falar a verdade em vez de so dizer "OCR gerado".
    const cadastro = { copiados: 0, falharam: 0, destino: null, motivo: null, ligado: !!cfg.pastaCadastro };

    for (const fonte of alvos) {
        const base = nomeBase(fonte.nome);
        // Destino PRINCIPAL: a estrutura OCR local. Espelha a subpasta (RT/IS/AP) do lado RAW.
        const destinoDir = pastaOcrDestino(os, gtin, fonte.subpasta);
        // O _ocr e marcador nosso, interno - o arquivo de OCR sai com o nome limpo.
        const baseSaida = temMarcaOcr(fonte.nome) ? base.slice(0, -SUFIXO_OCR.length) : base;
        const nomeSaida = baseSaida + (cfg.sufixoArquivo || '') + '.jpg';
        const destinoArq = path.join(destinoDir, nomeSaida);

        try {
            fs.mkdirSync(destinoDir, { recursive: true });

            // RAW: extrai o preview embutido (recorte de bytes, sem recomprimir).
            // JPG puro: nao tem preview menor embutido - recomprime de verdade (sharp),
            // mesma resolucao, so qualidade menor - mesmo efeito de peso do caminho RAW.
            const resultado = fonte.tipo === 'raw'
                ? extrairPreview(fonte.caminho)
                : await recomprimirParaOcr(fonte.caminho, cfg.qualidadeJpgOcr);

            if (resultado.ok) {
                fs.writeFileSync(destinoArq, resultado.buffer);
                gerados.push({ arquivo: nomeSaida, origem: fonte.tipo === 'raw' ? 'preview-embutido' : 'jpg-recomprimido', kb: Math.round(resultado.buffer.length / 1024) });
            } else {
                falhas.push({ arquivo: fonte.nome, motivo: resultado.motivo });
                continue;
            }

            const copia = copiarParaCadastro(cfg, os, gtin, fonte.subpasta, destinoArq, nomeSaida);
            if (copia.estado === 'copiado') {
                cadastro.copiados++;
                cadastro.destino = copia.destino;
            } else if (copia.estado === 'falhou') {
                cadastro.falharam++;
                cadastro.motivo = copia.motivo;
            }
        } catch (err) {
            falhas.push({ arquivo: fonte.nome, motivo: err.message });
        }
    }

    return {
        ok: falhas.length === 0,
        destino: pastaOcrDestino(os, gtin, null),
        gerados,
        falhas,
        cadastro
    };
}

module.exports = { gerarOcr, carregarConfig, listarFontesOcr, copiarParaCadastro };
