# JPG puro no fluxo de OCR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o modo OCR do sphoto-terminais funcionar corretamente quando a foto chega como JPG puro (sem `.cr2`/RAW par nenhum) — hoje isso ou quebra (`gerarOcr` devolve "Nenhum RAW encontrado") ou silenciosamente não copia pro Cadastro (`salvarImagens` em modo OCR).

**Architecture:** Novo módulo `lib/imagemOcr.js` usa `sharp` pra recomprimir um JPG puro (mesma resolução, qualidade menor) — o mesmo efeito de peso que o preview embutido do CR2 já dá pro caminho RAW. `lib/ocrCadastro.js::gerarOcr()` passa a listar RAW *e* JPG órfão como fontes válidas. `server.js::salvarImagens()` ganha um branch pro caso `modoOcr && JPG puro`, espelhando o branch que já existe pro RAW. Os dois pontos viram `async` porque `sharp` não tem API síncrona.

**Tech Stack:** Node.js puro (sem framework), `sharp` (nova dependência, ver Global Constraints), sem test runner no projeto — verificação via scripts Node descartáveis rodados manualmente (mesmo padrão que o resto do projeto já usa, não há jest/mocha aqui).

## Global Constraints

- Comentário em código: só explica o **porquê**, não o quê. Em português, sem acento.
- Sem framework novo, sem build, sem dependência nova **exceto** `sharp` (decisão explícita do usuário pra este projeto — commitar `node_modules/sharp` no repo pra estação continuar só "copiar pasta e rodar", sem precisar de `npm install`).
- `sharp` é assíncrono (sem API sync) — qualquer função que passe a chamá-lo vira `async`/devolve Promise.
- `Finalizadas\OS_x\gtin` (lado RAW/entrega) nunca é redimensionado — só renomeado. Isso já é assim hoje e **não muda** em nenhuma task deste plano.
- Plataforma de destino: Windows x64 (igual à máquina de desenvolvimento — os binários nativos do `sharp` baixados aqui servem nas estações).

---

## Mapa de arquivos

- **Modify:** `package.json` — adiciona `sharp` como dependency.
- **Modify:** `.gitignore` — remove `node_modules/` (a pasta não existe hoje no repo, nada de existente é desprotegido).
- **Create:** `lib/imagemOcr.js` — recompressão de JPG puro via `sharp`.
- **Modify:** `lib/ocrCadastro.js` — `listarRaws` vira `listarFontesOcr` (RAW + JPG órfão); `gerarOcr` vira `async` e usa `imagemOcr` pra fonte JPG; `carregarConfig` ganha `qualidadeJpgOcr` opcional (documentado, sem código extra — já é `JSON.parse` genérico).
- **Modify:** `server.js` — `salvarImagens` vira `async` com branch novo pra `modoOcr && JPG puro`; os dois handlers que chamam `salvarImagens`/`ocrCadastro.gerarOcr` passam a `await`.

---

### Task 1: Instalar `sharp` e liberar `node_modules` no git

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `node_modules/` (via `npm install`, depois commitado)

**Interfaces:**
- Produces: `require('sharp')` disponível pra qualquer módulo do projeto a partir daqui.

- [ ] **Step 1: Adicionar `sharp` ao `package.json` e instalar**

Rodar na raiz do projeto (`c:\sphoto-terminais`):

```bash
npm install sharp
```

Isso cria/atualiza `package.json` (dependency `sharp`) e `package-lock.json`, e baixa o binário nativo Windows x64 em `node_modules/@img/sharp-win32-x64` (ou equivalente da versão instalada).

- [ ] **Step 2: Verificar que o sharp carrega e funciona**

Rodar:

```bash
node -e "const sharp = require('sharp'); sharp({create:{width:10,height:10,channels:3,background:{r:255,g:0,b:0}}}).jpeg().toBuffer().then(buf => console.log('ok', buf.length > 0))"
```

Expected: imprime `ok true`.

- [ ] **Step 3: Liberar `node_modules` no `.gitignore`**

Editar `.gitignore` e remover a linha:

```
node_modules/
```

- [ ] **Step 4: Commitar `package.json`, `package-lock.json`, `.gitignore` e `node_modules`**

```bash
git add package.json package-lock.json .gitignore node_modules
git status
```

Conferir no `git status` que `node_modules/` aparece como novo (staged) e que nenhum arquivo de fora do esperado (ex.: `Finalizadas/`, `redmine-config.json`) foi incluído — esses continuam ignorados por outras linhas do `.gitignore` que não mudaram.

```bash
git commit -m "build: adiciona sharp (recompressao de JPG puro pro OCR) e commita node_modules"
```

---

### Task 2: `lib/imagemOcr.js` — recompressão de JPG puro

**Files:**
- Create: `lib/imagemOcr.js`

**Interfaces:**
- Consumes: `sharp` (Task 1).
- Produces: `recomprimirParaOcr(caminhoOrigem, qualidade) => Promise<{ok:true,buffer:Buffer}|{ok:false,motivo:string}>` e `QUALIDADE_JPG_OCR` (number, default 75) — usados pela Task 3 (`ocrCadastro.js`) e Task 4 (`server.js`).

- [ ] **Step 1: Criar o módulo**

Criar `lib/imagemOcr.js`:

```js
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
```

- [ ] **Step 2: Verificar com um script descartável**

Rodar (usa o próprio `sharp` pra gerar uma imagem de teste, sem depender de nenhuma foto real):

```bash
node -e "
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { recomprimirParaOcr, QUALIDADE_JPG_OCR } = require('./lib/imagemOcr');

const tmp = path.join(require('os').tmpdir(), 'sphoto-teste-imagemOcr.jpg');

sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 200, b: 40 } } })
    .jpeg({ quality: 100 })
    .toFile(tmp)
    .then(() => recomprimirParaOcr(tmp))
    .then(resultado => {
        if (!resultado.ok) throw new Error('falhou: ' + resultado.motivo);
        const tamOriginal = fs.statSync(tmp).size;
        console.log('original:', tamOriginal, 'recomprimido:', resultado.buffer.length);
        if (resultado.buffer.length >= tamOriginal) throw new Error('nao ficou mais leve');
        return sharp(resultado.buffer).metadata();
    })
    .then(meta => {
        console.log('dimensoes recomprimido:', meta.width, 'x', meta.height);
        if (meta.width !== 800 || meta.height !== 600) throw new Error('resolucao mudou - nao devia');
        console.log('OK - recomprimiu sem mudar resolucao, qualidade', QUALIDADE_JPG_OCR);
        fs.unlinkSync(tmp);
    })
    .catch(err => { console.error('FALHOU:', err.message); process.exit(1); });
"
```

Expected: imprime `original: <N> recomprimido: <M menor que N>`, depois `dimensoes recomprimido: 800 x 600`, depois `OK - recomprimiu sem mudar resolucao, qualidade 75`. Sem "FALHOU".

- [ ] **Step 3: Commit**

```bash
git add lib/imagemOcr.js
git commit -m "feat: adiciona recompressao de JPG puro pro OCR (lib/imagemOcr.js)"
```

---

### Task 3: `lib/ocrCadastro.js` — aceitar JPG órfão como fonte de OCR

**Files:**
- Modify: `lib/ocrCadastro.js`

**Interfaces:**
- Consumes: `imagemOcr.recomprimirParaOcr(caminhoOrigem, qualidade) => Promise<{ok,buffer|motivo}>` (Task 2).
- Produces: `gerarOcr(os, gtin, arquivos, config) => Promise<{ok, destino, gerados, falhas, cadastro}>` (mesmo shape de retorno de antes, agora assíncrono) — consumido pela Task 4 (`server.js`, endpoint `/api/ocr/gerar`).

- [ ] **Step 1: Trocar `listarRaws` por `listarFontesOcr` (RAW + JPG órfão)**

Em `lib/ocrCadastro.js`, substituir a função `listarRaws` (linhas 65-83 atuais) por:

```js
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
```

- [ ] **Step 2: Importar `imagemOcr` e trocar `gerarOcr` pra `async`, usando a fonte certa por `tipo`**

No topo do arquivo, junto dos outros `require`:

```js
const { recomprimirParaOcr } = require('./imagemOcr');
```

Substituir a função `gerarOcr` inteira (linhas 121-191 atuais) por:

```js
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
```

Nota: o campo `larg`/`alt` que existia no item de `gerados` pro caso RAW (vinha de `extrairPreview`) saiu do objeto genérico porque o caminho JPG (`recomprimirParaOcr`) não devolve dimensões — nada no projeto lê `gerados[].larg/alt` hoje (não aparece em `js/qa.js` nem `js/app.js`, é só exibido cru se algo ler `gerados`), então não é uma regressão de funcionalidade visível.

- [ ] **Step 3: Atualizar o `module.exports`**

Trocar a linha final do arquivo:

```js
module.exports = { gerarOcr, carregarConfig, listarRaws, copiarParaCadastro };
```

por:

```js
module.exports = { gerarOcr, carregarConfig, listarFontesOcr, copiarParaCadastro };
```

- [ ] **Step 4: Verificar com um script descartável**

Este script monta um GTIN de teste dentro de `Finalizadas` (pasta já gitignored, então não suja o repo), com um JPG puro e um par jpg+cr2 falso, chama `gerarOcr` e confere o resultado:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ocrCadastro = require('./lib/ocrCadastro');

const os = '999999-teste';
const gtin = '0000000000000';
const pastaGtin = path.join(__dirname, 'Finalizadas', 'OS_' + os, gtin);
fs.mkdirSync(pastaGtin, { recursive: true });

async function main() {
    // Foto 1: JPG puro, sem RAW - o caso novo.
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 0, g: 0, b: 255 } } })
        .jpeg({ quality: 100 })
        .toFile(path.join(pastaGtin, 'foto_jpg_puro.jpg'));

    // Foto 2: par jpg+cr2 (cr2 falso so pra testar que o RAW continua tendo prioridade
    // e o jpg do par nao vira fonte duplicada - o conteudo do cr2 nao importa aqui
    // porque extrairPreview vai falhar por nao achar SOF valido, e isso e esperado:
    // o teste so verifica que 'foto_com_par' NAO aparece em falhas como tipo jpg).
    fs.writeFileSync(path.join(pastaGtin, 'foto_com_par.cr2'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } } })
        .jpeg({ quality: 100 })
        .toFile(path.join(pastaGtin, 'foto_com_par.jpg'));

    const fontes = ocrCadastro.listarFontesOcr(os, gtin);
    console.log('fontes:', fontes.map(f => f.nome + ':' + f.tipo));
    const tiposEsperados = fontes.find(f => f.nome === 'foto_jpg_puro.jpg' && f.tipo === 'jpg')
        && fontes.find(f => f.nome === 'foto_com_par.cr2' && f.tipo === 'raw')
        && !fontes.find(f => f.nome === 'foto_com_par.jpg');
    if (!tiposEsperados) throw new Error('listarFontesOcr nao classificou como esperado');
    console.log('OK - listarFontesOcr classificou certo (RAW prioriza sobre o par, JPG puro entra como jpg)');

    const resultado = await ocrCadastro.gerarOcr(os, gtin, ['foto_jpg_puro.jpg'], {});
    console.log(JSON.stringify(resultado, null, 2));
    if (resultado.gerados.length !== 1 || resultado.gerados[0].origem !== 'jpg-recomprimido') {
        throw new Error('gerarOcr nao gerou o JPG puro via recompressao como esperado');
    }
    const destinoOcr = path.join(__dirname, 'Finalizadas', 'OCR', 'OS_' + os, gtin, 'foto_jpg_puro.jpg');
    if (!fs.existsSync(destinoOcr)) throw new Error('arquivo de OCR nao foi criado em ' + destinoOcr);
    console.log('OK - gerarOcr recomprimiu o JPG puro e gravou em', destinoOcr);

    fs.rmSync(path.join(__dirname, 'Finalizadas', 'OS_' + os), { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, 'Finalizadas', 'OCR', 'OS_' + os), { recursive: true, force: true });
}

main().catch(err => { console.error('FALHOU:', err.message); process.exit(1); });
"
```

Expected: imprime a lista de `fontes` mostrando `foto_jpg_puro.jpg:jpg` e `foto_com_par.cr2:raw` (sem `foto_com_par.jpg` na lista), depois `OK - listarFontesOcr classificou certo...`, depois o JSON do resultado de `gerarOcr` com `gerados: [{ arquivo: 'foto_jpg_puro.jpg', origem: 'jpg-recomprimido', kb: ... }]`, depois `OK - gerarOcr recomprimiu...`. Sem "FALHOU". As pastas de teste são removidas no final do próprio script.

- [ ] **Step 5: Commit**

```bash
git add lib/ocrCadastro.js
git commit -m "feat: gerarOcr aceita JPG puro (sem RAW) como fonte de OCR"
```

---

### Task 4: `server.js` — modo OCR na captura com JPG puro + wiring assíncrono

**Files:**
- Modify: `server.js:279-390` (função `salvarImagens`)
- Modify: `server.js:648-679` (handler `POST /api/salvar`)
- Modify: `server.js:1007-1039` (handler `POST /api/ocr/gerar`)

**Interfaces:**
- Consumes: `imagemOcr.recomprimirParaOcr` (Task 2), `ocrCadastro.gerarOcr` agora assíncrono (Task 3).
- Produces: nenhuma outra task depende disso — é o último elo da cadeia (endpoints HTTP).

- [ ] **Step 1: Importar `imagemOcr` no topo do `server.js`**

Junto dos outros `require` (linha ~6-9):

```js
const imagemOcr = require('./lib/imagemOcr');
```

- [ ] **Step 2: Tornar `salvarImagens` assíncrona e adicionar o branch `modoOcr && ehJpg`**

Trocar a assinatura da função (linha 279):

```js
function salvarImagens(dados) {
```

por:

```js
async function salvarImagens(dados) {
```

Trocar `fs.readdirSync(pastaTemp).forEach(nomeArquivo => {` (linha 318) por um laço que aceita `await` dentro (`forEach` não espera Promise):

```js
    if (fs.existsSync(pastaTemp)) {
        for (const nomeArquivo of fs.readdirSync(pastaTemp)) {
```

E o fechamento correspondente (linha 386-387, hoje `});` do `forEach` seguido do `}` do `if`) por:

```js
        }
    }
```

Dentro do laço, logo depois do branch existente do RAW (que termina em `return;` na linha 363, antes do `}` de fechamento do `if` da linha 341-364), adicionar o novo branch **antes** do bloco genérico `let destino;` (linha 366):

```js
            // Modo OCR + JPG puro (sem RAW par - camera sem RAW ou RAW-only desligado pra
            // essa foto): nao tem preview leve embutido pra extrair, entao recomprime de
            // verdade (mesma resolucao, qualidade menor) - mesmo efeito de peso que o
            // branch do RAW acima. Sem isso esse arquivo caia no bloco generico debaixo,
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

```

**Atenção:** dentro de um `for...of`, `return` encerra a função inteira (pulando os arquivos restantes da pasta temp) — antes, dentro do `forEach`, `return` só pulava aquele arquivo. Três `return;` precisam virar `continue;` pra manter o comportamento de "pula esse arquivo, processa o resto":

Trocar:

```js
            if (!fs.statSync(origem).isFile()) return;
```

por:

```js
            if (!fs.statSync(origem).isFile()) continue;
```

Trocar (dentro do branch RAW existente):

```js
            if (modoOcr && !ehJpg && ehRawExibivel(nomeArquivo)) {
                const preview = bytesParaExibir(origem);
                if (!preview) {
                    console.error('Modo OCR: sem preview embutido em', nomeArquivo, '- CR2 mantido na temp');
                    return;
                }
```

por:

```js
            if (modoOcr && !ehJpg && ehRawExibivel(nomeArquivo)) {
                const preview = bytesParaExibir(origem);
                if (!preview) {
                    console.error('Modo OCR: sem preview embutido em', nomeArquivo, '- CR2 mantido na temp');
                    continue;
                }
```

E, no fim do mesmo branch RAW, trocar:

```js
                contadorJpg++;
                movidos++;
                return;
            }
```

por:

```js
                contadorJpg++;
                movidos++;
                continue;
            }
```

(É o novo branch `modoOcr && ehJpg` que entra logo depois deste `}` de fechamento — ver bloco de código a seguir nesta task.)

Por fim, no branch genérico existente, trocar:

```js
            } else {
                return;
            }
```

por:

```js
            } else {
                continue;
            }
```

O `return { movidos, cadastro: resumoCadastro };` no final da função (fora do laço, depois do `if (fs.existsSync(pastaTemp))`) **não muda** — esse é o retorno normal da função e continua como `return`.

Revisar o corpo inteiro da função após a edição pra garantir que não sobrou nenhum `return;` solto dentro do laço `for...of` (só o `continue;` dos quatro pontos acima, mais o novo branch do Step seguinte).

- [ ] **Step 3: Atualizar o handler `POST /api/salvar` pra `await`**

Trocar (linha ~648-663):

```js
    if (req.method === 'POST' && req.url === '/api/salvar') {
        lerCorpo(req).then(corpo => {
```

por:

```js
    if (req.method === 'POST' && req.url === '/api/salvar') {
        lerCorpo(req).then(async corpo => {
```

E trocar (linha ~665-668):

```js
            try {
                const resultado = salvarImagens(dados);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, movidos: resultado.movidos, cadastro: resultado.cadastro }));
```

por:

```js
            try {
                const resultado = await salvarImagens(dados);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, movidos: resultado.movidos, cadastro: resultado.cadastro }));
```

- [ ] **Step 4: Atualizar o handler `POST /api/ocr/gerar` pra `await`**

Trocar (linha ~1007-1008):

```js
    if (req.method === 'POST' && req.url === '/api/ocr/gerar') {
        lerCorpo(req).then(corpo => {
```

por:

```js
    if (req.method === 'POST' && req.url === '/api/ocr/gerar') {
        lerCorpo(req).then(async corpo => {
```

E trocar (linha ~1024-1027):

```js
            try {
                const resultado = ocrCadastro.gerarOcr(dados.os, dados.gtin, dados.arquivos);
                res.writeHead(resultado.erro ? 404 : 200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(resultado));
```

por:

```js
            try {
                const resultado = await ocrCadastro.gerarOcr(dados.os, dados.gtin, dados.arquivos);
                res.writeHead(resultado.erro ? 404 : 200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(resultado));
```

- [ ] **Step 5: Verificar sintaxe e comportamento com um script descartável**

Primeiro, checagem rápida de sintaxe (pega erro de `continue`/`return` fora de lugar, chaves desalinhadas etc.):

```bash
node -c server.js
```

Expected: nenhuma saída (sucesso silencioso).

Depois, simular uma captura em modo OCR com um JPG puro na pasta temp, chamando `salvarImagens` diretamente (sem precisar do servidor HTTP nem da câmera):

```bash
node -e "
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BASE_PATH = __dirname;
const pastaTemp = path.join(BASE_PATH, 'images', 'temp');
fs.mkdirSync(pastaTemp, { recursive: true });

async function main() {
    await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 100, g: 100, b: 200 } } })
        .jpeg({ quality: 100 })
        .toFile(path.join(pastaTemp, 'foto_camera.jpg'));

    // server.js roda process.on('uncaughtException', ...) com process.exit(1) - carregar o
    // modulo aqui so pra reusar salvarImagens exigiria subir o servidor HTTP de verdade.
    // Mais simples e direto pro teste: reimplementar a chamada via require isolado nao da
    // porque salvarImagens nao e exportada. Entao este script testa via HTTP mesmo:
    // ele assume que 'node server.js' ja esta rodando em outro terminal (iniciar-server.bat
    // ou 'node server.js' manual) antes de rodar este bloco.
    const resp = await fetch('http://localhost:3000/api/salvar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ os: '999999-teste', gtin: '1111111111111', perfil: 'estudio', modoOcr: true })
    });
    const dados = await resp.json();
    console.log(JSON.stringify(dados, null, 2));
    if (!dados.ok || dados.movidos !== 1) throw new Error('salvarImagens nao processou o JPG puro em modo OCR como esperado');

    const destinoOcr = path.join(BASE_PATH, 'Finalizadas', 'OCR', 'OS_999999-teste', '1111111111111', 'foto_camera.jpg');
    console.log('existe em OCR?', fs.existsSync(destinoOcr));
    console.log('existe em Finalizadas RAW (nao deveria)?', fs.existsSync(path.join(BASE_PATH, 'Finalizadas', 'OS_999999-teste', '1111111111111', 'foto_camera.jpg')));

    fs.rmSync(path.join(BASE_PATH, 'Finalizadas', 'OCR', 'OS_999999-teste'), { recursive: true, force: true });
    fs.rmSync(path.join(BASE_PATH, 'Finalizadas', 'OS_999999-teste'), { recursive: true, force: true });
}

main().catch(err => { console.error('FALHOU:', err.message); process.exit(1); });
"
```

**Antes de rodar o bloco acima**, subir o servidor manualmente num terminal separado (`node server.js`, na raiz do projeto) e deixar rodando — o script de verificação fala com `http://localhost:3000`. Expected: JSON com `ok: true`, `movidos: 1`, `cadastro.copiados` ou `cadastro.ligado: false` (depende se `ocr-config.json` tem `pastaCadastro` configurado nesta máquina de dev — qualquer um dos dois é aceitável, o que importa é `movidos: 1` e o arquivo existir em OCR); depois `existe em OCR? true` e `existe em Finalizadas RAW (nao deveria)? false`. Encerrar o `node server.js` do terminal separado depois de verificar.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: modo OCR na captura recomprime JPG puro (sem RAW) e copia pro Cadastro"
```

---

## Verificação final (manual, na tela — não automatizável sem o hardware da câmera)

Depois das 4 tasks, confirmar na estação de fato (ou simulando arquivos na pasta certa):

1. Ligar o checkbox de modo OCR, capturar (ou colocar manualmente um `.jpg` em `images/temp`) e salvar — conferir em `Finalizadas\OCR\OS_x\gtin` que o arquivo tem nome padronizado, é mais leve que o original, e que a tela mostra o resumo de cópia pro Cadastro (sucesso ou motivo da falha).
2. Ter um GTIN em `Finalizadas\OS_x\gtin` só com `.jpg` (sem RAW) e clicar no botão de gerar OCR na tela — conferir que não aparece mais "Nenhum RAW encontrado".
3. Capturar RAW+JPG fora do modo OCR — conferir que o `Finalizadas\OS_x\gtin` recebe os arquivos com o mesmo tamanho de antes (nenhum redimensionamento).
