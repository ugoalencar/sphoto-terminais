# JPG puro nas tratativas de OCR (sem RAW par)

## Contexto

O sphoto-terminais é pensado pro par jpg+cr2 (ou RAW-only). Mas existem GTINs onde a
foto chega como **JPG puro** — sem `.cr2`/`.cr3`/`.nef`/`.arw`/`.dng` nenhum. A maior
parte do pipeline já trata isso bem, porque não filtra por extensão:

- `lib/qaHub.js` (mover pra subpasta, marcar sufixo `_coding`, casar par jpg+cr2) —
  `EXTENSOES_PAR` já inclui `.jpg`/`.jpeg`/`.png`.
- Scanner `OS_NONE` (`moverPastaGtin` em `server.js`) — move qualquer arquivo da pasta,
  não filtra extensão.
- `salvarImagens()` fora do modo OCR — o branch `ehJpg` só renomeia pro padrão
  `GTIN_dd_MM_yyyy_HH_mm_ss_indice.ext`, sem mexer em resolução. Já é o comportamento
  certo pro lado RAW/entrega (`Finalizadas\OS_x\gtin`) e continua assim.

O que quebra (ou se comporta errado) é especificamente o **modo OCR**, que hoje assume
que a fonte é sempre RAW (pra extrair o preview embutido, ~12x mais leve que o JPG da
câmera, ver `lib/cr2Preview.js`). Dois pontos:

1. **`salvarImagens()` em modo OCR + JPG puro chegando na temp**: cai no branch
   genérico (`ehJpg`), que só renomeia — **não recomprime e não chama
   `ocrCadastro.copiarParaCadastro`**. Resultado: uma captura 100% JPG com o
   checkbox de OCR ligado nunca chega no Cadastro. É bug, não só falta de otimização.
2. **`lib/ocrCadastro.js::gerarOcr()`** (endpoint `POST /api/ocr/gerar`, botão de
   gerar OCR a partir de fotos já finalizadas): `listarRaws()` só enxerga extensão
   RAW. Se o GTIN em `Finalizadas\OS_x\gtin` só tem JPG, devolve
   `"Nenhum RAW encontrado"` e a geração falha inteira, mesmo tendo fotos.

## Por que precisa de uma lib nova (sharp)

O "preview leve" do CR2 não é redimensionamento — é recorte de bytes de um JPEG que a
câmera já grava menor dentro do RAW (mesma resolução do JPG final, ~12x mais leve só
por causa da qualidade/compressão usada na hora de gravar). Um JPG puro não carrega
essa versão menor embutida; pra reduzir peso de verdade é preciso decodificar e
recomprimir a imagem, o que não dá pra fazer sem uma lib de imagem (não existe
`sharp`/`jimp`/ImageMagick disponível hoje, e o projeto não usa build nem npm install
nas estações).

Decisão (confirmada com o Ugo): adicionar `sharp` como dependência, **mesma
resolução, só qualidade JPEG menor** (`quality: 75`). Instala uma vez nesta máquina
(que tem internet) e o `node_modules` vai commitado no repositório — as estações
continuam só copiando a pasta, sem rodar `npm install`. `node_modules/` sai do
`.gitignore` para viabilizar isso (hoje a pasta nem existe no repo, então não há nada
de existente sendo desprotegido).

## Mudanças

### 1. `package.json`
Adiciona `sharp` como dependency. `npm install sharp` roda uma vez nesta máquina
(Windows x64 — mesma plataforma das estações, então o binário nativo baixado serve).

### 2. `.gitignore`
Remove a linha `node_modules/`. Depois do `npm install`, `node_modules/` (incluindo
`sharp` e os pacotes `@img/sharp-win32-x64` etc.) entra no commit.

### 3. Novo módulo `lib/imagemOcr.js`
Função única, isolada, pra não espalhar `require('sharp')` por vários arquivos:

```js
const sharp = require('sharp');

const QUALIDADE_JPG_OCR = 75;

// Recomprime um JPG puro (sem RAW pra extrair preview leve) pro padrao OCR: mesma
// resolucao, qualidade menor - mesmo efeito de peso que o preview embutido do CR2,
// so que via recompressao de verdade (nao tem preview menor pronto num jpg puro).
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
```

### 4. `lib/ocrCadastro.js`
- `listarRaws()` vira `listarFontesOcr(os, gtin)`: varre raiz + RT/IS/AP igual hoje,
  mas devolve `{ caminho, nome, subpasta, tipo }` onde `tipo` é `'raw'` (extensão RAW)
  ou `'jpg'` (extensão `.jpg`/`.jpeg` **sem** um RAW de mesmo nome-base na mesma
  pasta — pra não duplicar quando o par existe, já que nesse caso o RAW é a fonte
  preferida, igual hoje).
- `gerarOcr()` vira `async`. Pra cada fonte: se `tipo === 'raw'`, extrai o preview
  embutido (como hoje, `extrairPreview`); se `tipo === 'jpg'`, chama
  `imagemOcr.recomprimirParaOcr(fonte.caminho)`. O resto do fluxo (nome de saída,
  marca `_ocr`, cópia pro Cadastro via `copiarParaCadastro`, resumo de
  gerados/falhas) não muda — só troca de onde vem o buffer.
- Config opcional `qualidadeJpgOcr` em `ocr-config.json`, repassada pra
  `recomprimirParaOcr` (mesmo padrão do `sufixoArquivo` que já existe).

### 5. `server.js`
- **`salvarImagens()`** vira `async`. Novo branch, espelhando o do RAW (linha ~341):
  `if (modoOcr && ehJpg) { ... }` — chama `imagemOcr.recomprimirParaOcr(origem)`,
  grava o resultado em `pastaDestinoJpg` com o nome padronizado
  (`GTIN_timestamp_indice.jpg`), apaga o arquivo original da temp, chama
  `ocrCadastro.copiarParaCadastro` e contabiliza em `resumoCadastro` — igual ao
  branch RAW hoje. Isso substitui o branch genérico `ehJpg` só pro caso
  `modoOcr === true`; fora do modo OCR, o branch genérico continua exatamente como
  está (renomeia sem mexer em resolução).
- Endpoint `POST /api/salvar` (linha ~666): troca a chamada síncrona por
  `await salvarImagens(dados)` dentro do `.then()` já existente (o handler já é
  assíncrono por causa do `lerCorpo`, então é só adicionar `async`/`await` ali).
- Endpoint `POST /api/ocr/gerar` (linha ~1025): troca
  `ocrCadastro.gerarOcr(...)` síncrono por `await ocrCadastro.gerarOcr(...)`
  (mesmo padrão).

### 6. O que **não** muda
- `Finalizadas\OS_x\gtin` fora do modo OCR: continua só renomeando, nunca
  redimensionando — comportamento já correto hoje pro JPG puro.
- Scanner `OS_NONE` (`moverPastaGtin`): já move qualquer extensão, sem alteração.
- `lib/qaHub.js`: já trata `.jpg` em `EXTENSOES_PAR`, sem alteração.

## Teste manual (sem harness de teste automatizado no projeto)

1. Colocar um JPG puro (sem `.cr2` par) na pasta `images/temp`, marcar OCR, salvar
   com o checkbox de modo OCR ligado — conferir que o arquivo aparece em
   `Finalizadas\OCR\OS_x\gtin` com nome padronizado, tamanho reduzido (comparar peso
   antes/depois) e mesma resolução (abrir e conferir dimensões), e que o resumo
   retornado (`cadastro.copiados`) reflete a cópia pro Cadastro (ou o motivo da
   falha, se a pasta de rede estiver fora do ar).
2. Colocar um GTIN em `Finalizadas\OS_x\gtin` só com JPG (sem RAW), chamar
   `POST /api/ocr/gerar` (botão da tela) — conferir que não devolve mais
   `"Nenhum RAW encontrado"` e que o JPG gerado em `OCR\OS_x\gtin` tem peso menor
   que o original.
3. Conferir que um GTIN com par jpg+cr2 continua preferindo o RAW (preview
   embutido) e não duplica a mesma foto via `tipo: 'jpg'`.
4. Conferir que uma captura RAW+JPG (não modo OCR) continua indo pro
   `Finalizadas\OS_x\gtin` sem qualquer redimensionamento (comparar tamanho de
   arquivo antes/depois — deve ser idêntico).
