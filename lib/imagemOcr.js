// Recompressao de JPG puro (sem RAW par) pro padrao OCR.
//
// O preview leve do CR2 (ver lib/cr2Preview.js) nao e redimensionamento - e recorte de
// bytes de um JPEG que a camera ja grava menor dentro do RAW, mesma resolucao do JPG
// final. Um JPG puro nao carrega essa versao menor embutida; pra reduzir peso de
// verdade precisa decodificar e recomprimir - por isso o sharp aqui, unico lugar do
// projeto que usa uma lib de imagem de verdade.

const sharp = require('sharp');

const QUALIDADE_JPG_OCR = 75;

// Recomprime um JPG puro: mesma resolucao (nunca redimensiona pixel), so qualidade
// menor - mesmo efeito de peso que o preview embutido do CR2 da pro caminho RAW.
// Devolve ok:false em vez de lancar - quem chama decide o fallback (ex: manter o
// arquivo original), igual ao padrao de extrairPreview() em cr2Preview.js.
async function recomprimirParaOcr(caminhoOrigem, qualidade) {
    try {
        const buffer = await sharp(caminhoOrigem)
            .jpeg({ quality: qualidade || QUALIDADE_JPG_OCR })
            .toBuffer();
        return { ok: true, buffer };
    } catch (err) {
        return { ok: false, motivo: err.message };
    }
}

module.exports = { recomprimirParaOcr, QUALIDADE_JPG_OCR };
