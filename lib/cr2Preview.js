// Extrai o JPEG de preview que ja vem embutido dentro de um CR2 (Canon RAW).
//
// Todo CR2 carrega previews JPEG prontos: um thumbnail pequeno (~160x120, 9 KB) e um
// preview em resolucao cheia (6240x4160, ~1,7 MB nas fotos daqui). Isso NAO e decodificar
// RAW - e recorte de bytes, ~20 ms por foto, sem nenhuma dependencia externa (nada de
// dcraw/libraw/ImageMagick pra instalar na maquina do fotografo).
//
// ATENCAO (a pegadinha do formato): os dados do sensor tambem sao gravados dentro do CR2
// como "lossless JPEG" - ele tem o mesmo marcador de inicio (FFD8FF) e por isso aparece
// numa varredura ingenua, mas NAO e uma foto visualizavel. Ele se distingue pelo SOF:
//   SOF0/SOF1/SOF2 + 3 componentes = foto de verdade (o que a gente quer)
//   SOF3 (lossless) + 4 componentes = dados do sensor (descartar)
// Por isso filtramos por SOF e pegamos o MAIOR preview visualizavel.

const fs = require('fs');

// Marcadores SOF que representam foto visualizavel (baseline / sequencial / progressivo).
const SOF_FOTO = [0xC0, 0xC1, 0xC2];
// Marcadores que NAO carregam dimensoes (nao sao SOF apesar de estarem na faixa 0xC0-0xCF).
const NAO_SOF = [0xC4, 0xC8, 0xCC];

// Le o cabecalho de um JPEG e devolve dimensoes/tipo, ou null se nao der pra ler.
function dimensoesJpeg(buf) {
    let i = 2;
    while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marcador = buf[i + 1];
        if (marcador === 0xD8 || (marcador >= 0xD0 && marcador <= 0xD9)) { i += 2; continue; }
        if (marcador >= 0xC0 && marcador <= 0xCF && !NAO_SOF.includes(marcador)) {
            return {
                alt: buf.readUInt16BE(i + 5),
                larg: buf.readUInt16BE(i + 7),
                comps: buf[i + 9],
                sof: marcador
            };
        }
        if (i + 3 >= buf.length) break;
        const tamSegmento = buf.readUInt16BE(i + 2);
        if (tamSegmento < 2) break; // segmento corrompido - para em vez de entrar em loop
        i += 2 + tamSegmento;
    }
    return null;
}

// Varre o CR2 atras dos JPEGs embutidos (SOI FFD8FF ... EOI FFD9).
function acharJpegsEmbutidos(buf, limite) {
    const achados = [];
    for (let i = 0; i < buf.length - 3; i++) {
        if (buf[i] !== 0xFF || buf[i + 1] !== 0xD8 || buf[i + 2] !== 0xFF) continue;
        for (let j = i + 2; j < buf.length - 1; j++) {
            if (buf[j] === 0xFF && buf[j + 1] === 0xD9) {
                achados.push({ inicio: i, tam: j - i + 2 });
                i = j + 1;
                break;
            }
        }
        if (limite && achados.length >= limite) break;
    }
    return achados;
}

// Extrai o maior preview VISUALIZAVEL de um CR2.
// Devolve { ok: true, buffer, larg, alt, tam } ou { ok: false, motivo }.
// Quem chama deve tratar ok:false caindo no JPG da camera (fallback) - camera de outro
// modelo pode embutir diferente, e melhor degradar do que quebrar.
function extrairPreview(caminhoCr2) {
    let buf;
    try {
        buf = fs.readFileSync(caminhoCr2);
    } catch (err) {
        return { ok: false, motivo: 'nao consegui ler o arquivo: ' + err.message };
    }

    const candidatos = [];
    for (const achado of acharJpegsEmbutidos(buf, 6)) {
        const sub = buf.subarray(achado.inicio, achado.inicio + achado.tam);
        const d = dimensoesJpeg(sub);
        if (!d) continue;
        // So foto de verdade: descarta o lossless JPEG (dados do sensor).
        if (!SOF_FOTO.includes(d.sof) || d.comps !== 3) continue;
        candidatos.push({ buffer: sub, tam: achado.tam, larg: d.larg, alt: d.alt });
    }

    if (candidatos.length === 0) {
        return { ok: false, motivo: 'nenhum preview JPEG visualizavel embutido (modelo de camera diferente?)' };
    }

    // O maior = o de resolucao cheia (o pequeno e o thumbnail de 160x120).
    const maior = candidatos.reduce((a, b) => (b.larg * b.alt > a.larg * a.alt ? b : a));
    return { ok: true, buffer: maior.buffer, larg: maior.larg, alt: maior.alt, tam: maior.tam };
}

module.exports = { extrairPreview, dimensoesJpeg, acharJpegsEmbutidos };
