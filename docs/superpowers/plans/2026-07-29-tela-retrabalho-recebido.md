# Tela de Retrabalho Recebido na Captura Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a tela de captura (`index.html`/`js/app.js`) do sphoto-terminais passa a mostrar, pra
um GTIN com status "retrabalho", os motivos (do TXT que o QA gerou) e as fotos que vieram de
volta na pasta que a regra RECEIVER do `syncIMG.jar` entrega — puramente informativo, sem ação
de "concluir".

**Architecture:** novo módulo `lib/retrabalhoRecebido.js` localiza a pasta/TXT em
`C:\SyncIMGSend\Retrabalho\<OS decorada>\<gtin>\` (reaproveitando
`localizarPastaDecoradaPorPrefixo`, hoje privada em `lib/qaHub.js`, que passa a ser exportada) e
lê os motivos filtrados pro GTIN; `server.js` expõe isso numa rota nova que combina com
`listarImagensBase64` (já existe) pras miniaturas; `js/app.js` busca e renderiza um painel novo
(manipulação manual de DOM, mesmo padrão já usado no resto do arquivo — este projeto não usa
templates Vue).

**Tech Stack:** Node.js core (sem framework), Vue 3 só como container de estado reativo (sem
templates — DOM manipulado manualmente via `document.createElement`/`innerHTML`, ver
`renderizarMiniaturas`/`renderizarListaGtins` já existentes).

## Global Constraints

- Sem CDN, sem build, sem dependência nova (`package.json` só tem `bootstrap-icons` hoje) — regra
  do projeto (`CLAUDE.md`).
- Comentário em código: português sem acento, explicando o PORQUÊ.
- Sem framework de teste automatizado neste projeto (confirmado: nenhum `.test.js`, nenhum script
  de teste em `package.json`) — verificação é `node --check` + teste manual com pasta fake.
- Painel é SÓ LEITURA — nenhuma ação de "concluir retrabalho", nenhuma escrita no Redmine, nenhum
  botão novo além do que já existe.
- Se a pasta/TXT não existir (regra RECEIVER do robô ainda não instalada, ou retrabalho ainda não
  chegou), o painel simplesmente não aparece — nunca é tratado como erro pro fotógrafo.
- Caminho base: `C:\SyncIMGSend\Retrabalho` — mesma constante `SYNCIMGSEND_BASE = 'C:\\SyncIMGSend'`
  que `lib/qaHub.js` já usa pros outros caminhos do robô (linha 95).
- Porta do servidor: 3000 (`http://localhost:3000`, mesma base usada em todos os `fetch` já
  existentes em `js/app.js`).

---

### Task 1: `lib/retrabalhoRecebido.js` — localizar pasta/TXT recebidos

**Files:**
- Create: `lib/retrabalhoRecebido.js`
- Modify: `lib/qaHub.js:1141`

**Interfaces:**
- Consumes: `localizarPastaDecoradaPorPrefixo(baseDir, prefixoAlvo, prefixoRegex)` de
  `lib/qaHub.js` (já existe, linha 469-478 — só precisa ser exportada).
- Produces: `buscarRetrabalhoRecebido(os, gtin)` → `{ pastaGtinPath: string, motivos: string[] }
  | null` — consumida pela Task 2 (`server.js`).

- [ ] **Step 1: Exportar `localizarPastaDecoradaPorPrefixo` de `lib/qaHub.js`**

Em `lib/qaHub.js`, encontre a linha final do arquivo (linha 1141):

```js
module.exports = { tratar, moverParaSubpasta, listarArquivosDeSubpastas, SUBPASTAS_TAG, isNomeSeguro, paresNaPasta, removerPares, nomeBase };
```

Troque por:

```js
module.exports = { tratar, moverParaSubpasta, listarArquivosDeSubpastas, SUBPASTAS_TAG, isNomeSeguro, paresNaPasta, removerPares, nomeBase, localizarPastaDecoradaPorPrefixo };
```

- [ ] **Step 2: Criar `lib/retrabalhoRecebido.js`**

```js
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
```

- [ ] **Step 3: Checagem de sintaxe**

Run: `cd c:\sphoto-terminais && node --check lib/qaHub.js && node --check lib/retrabalhoRecebido.js`
Expected: sem saída (exit code 0).

- [ ] **Step 4: Verificação manual com pasta fake**

Ainda não há regra RECEIVER instalada nesta máquina, então cria-se uma pasta fake pra validar a
lógica de leitura isoladamente, num script Node de uma linha (não precisa do servidor rodando):

```powershell
New-Item -ItemType Directory -Force -Path "C:\SyncIMGSend\Retrabalho\OS_99999---(1 GTINs)---2026-08-01\7898994680758" | Out-Null
Set-Content -Path "C:\SyncIMGSend\Retrabalho\OS_99999---(1 GTINs)---2026-08-01\Retrabalho_OS_99999.txt" -Value "7898994680758 - foto1.jpg: Fora de foco, Sujeira no fundo" -Encoding utf8
node -e "console.log(require('./lib/retrabalhoRecebido').buscarRetrabalhoRecebido('99999', '7898994680758'))"
```

Expected: imprime `{ pastaGtinPath: 'C:\\SyncIMGSend\\Retrabalho\\OS_99999---(1 GTINs)---2026-08-01\\7898994680758', motivos: [ 'foto1.jpg: Fora de foco, Sujeira no fundo' ] }`.

Depois, confirme o caso "sem pasta":

```powershell
node -e "console.log(require('./lib/retrabalhoRecebido').buscarRetrabalhoRecebido('11111', '0000000000000'))"
```

Expected: imprime `null`.

**Não apague a pasta fake ainda** — a Task 2 reaproveita ela pro teste da rota.

- [ ] **Step 5: Commit**

```bash
cd c:\sphoto-terminais
git add lib/qaHub.js lib/retrabalhoRecebido.js
git commit -m "feat: le retrabalho recebido do QA (pasta + motivos) em lib/retrabalhoRecebido.js"
```

---

### Task 2: `server.js` — rota `GET /api/retrabalho`

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `buscarRetrabalhoRecebido(os, gtin)` de `lib/retrabalhoRecebido.js` (Task 1);
  `listarImagensBase64(dirPath)` (já existe em `server.js`, linha 205 — devolve
  `{ nome, arquivo }[]`, `arquivo` em base64); `isNomeSeguro(valor)` (já existe, linha 84).
- Produces: `GET /api/retrabalho?os=&gtin=` → `{ ok: true, retrabalho: { motivos: string[],
  fotos: {nome,arquivo}[] } | null }` — consumida pela Task 3 (`js/app.js`).

- [ ] **Step 1: Importar o módulo novo**

Em `server.js`, encontre a linha 8:

```js
const cr2Preview = require('./lib/cr2Preview');
```

Adicione logo depois:

```js
const retrabalhoRecebido = require('./lib/retrabalhoRecebido');
```

- [ ] **Step 2: Adicionar a rota**

Encontre o final do bloco `/api/imagens/anterior` (por volta da linha 1086, procure o `return;`
que fecha esse `if`, logo antes do bloco `if (req.url === '/api/temp')`):

```js
        res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': assinatura });
        res.end(JSON.stringify({ imagens: listarImagensAnterior(os, gtin) }));
        return;
    }

    if (req.url === '/api/temp') {
```

Adicione a rota nova ENTRE esses dois blocos (logo depois do `}` que fecha `/api/imagens/anterior`,
antes do `if (req.url === '/api/temp')`):

```js
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

```

- [ ] **Step 3: Checagem de sintaxe**

Run: `cd c:\sphoto-terminais && node --check server.js`
Expected: sem saída (exit code 0).

- [ ] **Step 4: Verificação manual via curl**

Reaproveita a pasta fake criada na Task 1 (Step 4) — não apague antes deste teste.

1. Suba o servidor (`cd c:\sphoto-terminais && node server.js`, em background — porta 3000, a
   mesma porta de produção deste projeto; se já houver um servidor rodando nela, pare antes com
   `parar.bat` e confirme a porta livre, nunca derrube um processo à força sem confirmar de quem
   é).
2. `curl "http://localhost:3000/api/retrabalho?os=99999&gtin=7898994680758"` — esperado:
   `{"ok":true,"retrabalho":{"motivos":["foto1.jpg: Fora de foco, Sujeira no fundo"],"fotos":[]}}`
   (lista de fotos vazia porque a pasta fake não tem nenhum `.jpg` real dentro, só o TXT — ok pra
   este teste, o Step 6 da Task 3 testa com foto de verdade).
3. `curl "http://localhost:3000/api/retrabalho?os=11111&gtin=0000000000000"` — esperado:
   `{"ok":true,"retrabalho":null}`.
4. `curl "http://localhost:3000/api/retrabalho?os=..%2F..&gtin=x"` — esperado: `400` (bloqueado
   por `isNomeSeguro`).
5. Pare o servidor (mate só o PID que você iniciou; confirme porta 3000 livre via
   `netstat -ano | grep :3000` antes de seguir).

- [ ] **Step 5: Commit**

```bash
cd c:\sphoto-terminais
git add server.js
git commit -m "feat: rota GET /api/retrabalho devolve motivos+fotos do retrabalho recebido"
```

---

### Task 3: Front-end — painel de retrabalho na tela de captura

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `GET /api/retrabalho?os=&gtin=` (Task 2), campo `gtin.status` já existente em
  `estado.listaGtins` (`'retrabalho'` quando `Situação das Imagens` = "Retrabalho", ver
  `js/app.js:418-419`).
- Produces: nada consumido por tarefas futuras (última tarefa do plano).

- [ ] **Step 1: Painel novo em `index.html`**

Encontre o fechamento da "Row 1" (por volta da linha 119-121):

```html
                    </div>
                </div>

                <!-- Row 2: Layout principal - Esquerda (Imagens) + Direita (GTINs) -->
```

Adicione o painel novo ENTRE o fechamento da Row 1 e o comentário da Row 2:

```html
                    </div>
                </div>

                <!-- Retrabalho recebido do QA - so aparece quando ha pasta/motivos pra este GTIN -->
                <div class="row g-3 mb-3 d-none" id="painelRetrabalho">
                    <div class="col-12">
                        <div class="card border-warning">
                            <div class="card-header py-2">
                                <h6 class="card-title mb-0"><i class="bi bi-arrow-repeat"></i> Retrabalho recebido do QA - refazer estas fotos</h6>
                            </div>
                            <div class="card-body p-2">
                                <ul class="list-group list-group-flush mb-2" id="listaMotivosRetrabalho"></ul>
                                <div class="row g-2" id="gridRetrabalho"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Row 2: Layout principal - Esquerda (Imagens) + Direita (GTINs) -->
```

- [ ] **Step 2: Estado novo em `js/app.js`**

Encontre a linha (por volta da linha 27):

```js
            subpastasAnterior: { RT: [], IS: [], AP: [] },
```

Adicione logo depois:

```js
            subpastasAnterior: { RT: [], IS: [], AP: [] },
            retrabalhoRecebido: null,
```

- [ ] **Step 3: Função de busca**

Encontre o final da função `buscarImagensOS` (por volta da linha 611-614):

```js
                .catch(function(err) {
                    console.error('Erro ao buscar imagens anterior (server.js rodando?):', err);
                });
        }
```

Adicione logo depois (nova função, mesmo nível de indentação):

```js

        function buscarRetrabalhoRecebido() {
            var query = new URLSearchParams({
                os: estado.osAtual,
                gtin: estado.gtinAtual
            });
            fetch('http://localhost:3000/api/retrabalho?' + query.toString())
                .then(function(resp) { return resp.json(); })
                .then(function(dados) {
                    if (!dados || !dados.ok) return;
                    estado.retrabalhoRecebido = dados.retrabalho;
                    renderizarPainelRetrabalho();
                })
                .catch(function(err) {
                    console.error('Erro ao buscar retrabalho recebido (server.js rodando?):', err);
                });
        }
```

- [ ] **Step 4: Função de renderização**

Encontre o final da função `renderizarMiniaturas` (por volta da linha 1026-1027):

```js
                } else {
                    gridAtual.innerHTML = '<div class="col-12 grid-empty">Nenhuma imagem nesta sessão</div>';
                }
            }
        }
```

Adicione logo depois (nova função, mesmo nível de indentação):

```js

        function renderizarPainelRetrabalho() {
            const painel = document.getElementById('painelRetrabalho');
            if (!painel) return;

            const dado = estado.retrabalhoRecebido;
            if (!dado) {
                painel.classList.add('d-none');
                return;
            }
            painel.classList.remove('d-none');

            const lista = document.getElementById('listaMotivosRetrabalho');
            lista.innerHTML = '';
            if (dado.motivos && dado.motivos.length > 0) {
                dado.motivos.forEach(function(motivo) {
                    const li = document.createElement('li');
                    li.className = 'list-group-item';
                    li.textContent = motivo;
                    lista.appendChild(li);
                });
            } else {
                lista.innerHTML = '<li class="list-group-item text-muted">Nenhum motivo registrado no TXT pra este GTIN.</li>';
            }

            const grid = document.getElementById('gridRetrabalho');
            grid.innerHTML = '';
            (dado.fotos || []).forEach(function(foto) {
                const col = document.createElement('div');
                col.className = 'col-md-3 col-sm-4 col-6 mb-3';
                const miniatura = document.createElement('div');
                miniatura.className = 'miniatura';
                miniatura.innerHTML = '<img src="data:image/jpeg;base64,' + foto.arquivo + '" alt="' + (foto.nome || 'Imagem') + '">';
                col.appendChild(miniatura);
                grid.appendChild(col);
            });
        }
```

- [ ] **Step 5: Disparar a busca ao selecionar um GTIN em retrabalho**

Encontre a função `selecionarGtin` (por volta da linha 1244-1258):

```js
        function selecionarGtin(index) {
            const gtin = estado.listaGtins[index];
            if (gtin) {
                estado.gtinAtual = gtin.gtin;
                estado.gtinAtivoIndex = index;
                estado.descricaoProduto = gtin.descricao;
                estado.imagensAnterior = [];
                ultimoEtagAnterior = null;

                document.getElementById('inputGtin').value = gtin.gtin;

                buscarImagensOS();
                atualizarDOM();
            }
        }
```

Troque por:

```js
        function selecionarGtin(index) {
            const gtin = estado.listaGtins[index];
            if (gtin) {
                estado.gtinAtual = gtin.gtin;
                estado.gtinAtivoIndex = index;
                estado.descricaoProduto = gtin.descricao;
                estado.imagensAnterior = [];
                ultimoEtagAnterior = null;
                estado.retrabalhoRecebido = null;
                renderizarPainelRetrabalho();

                document.getElementById('inputGtin').value = gtin.gtin;

                buscarImagensOS();
                if (gtin.status === 'retrabalho') {
                    buscarRetrabalhoRecebido();
                }
                atualizarDOM();
            }
        }
```

- [ ] **Step 6: Sincronizar o painel escondido no carregamento inicial**

Encontre o bloco `onMounted` (por volta da linha 1517-1525):

```js
        onMounted(function() {
            carregarVersao();
            verificarAtualizacao();
            carregarConfigLocal();
            conectarWebSocket();
            configurarEventListeners();
            renderizarListaGtins();
            renderizarMiniaturas();
        });
```

Troque por:

```js
        onMounted(function() {
            carregarVersao();
            verificarAtualizacao();
            carregarConfigLocal();
            conectarWebSocket();
            configurarEventListeners();
            renderizarListaGtins();
            renderizarMiniaturas();
            renderizarPainelRetrabalho();
        });
```

- [ ] **Step 7: Checagem de sintaxe**

Run: `cd c:\sphoto-terminais && node --check js/app.js`
Expected: sem saída (exit code 0).

- [ ] **Step 8: Verificação manual end-to-end**

Reaproveita a pasta fake da Task 1 — desta vez adicione uma foto de verdade nela pra testar a
grade de miniaturas:

1. Copie qualquer `.jpg` pequeno pra
   `C:\SyncIMGSend\Retrabalho\OS_99999---(1 GTINs)---2026-08-01\7898994680758\foto1.jpg`.
2. Suba o servidor (`cd c:\sphoto-terminais && node server.js`, porta 3000 — mesmo cuidado do
   Step 4 da Task 2, nunca derrubar processo sem confirmar de quem é).
3. Abra `http://localhost:3000` no navegador. Na lista de GTINs (lado direito), force
   temporariamente (via DevTools console: `app.__vueParentComponent` não se aplica aqui, então
   simplesmente edite manualmente um item de `estado.listaGtins` não é acessível de fora — em vez
   disso, o teste real é: busque um GTIN cuja Situação no Redmine já esteja "Retrabalho", OU
   simplesmente valide a chamada de rede diretamente: abra o DevTools, aba Network, selecione
   qualquer GTIN da lista, e confirme que SÓ dispara a chamada a `/api/retrabalho` quando o status
   daquele GTIN já é `retrabalho` — se nenhum GTIN de teste estiver nesse status agora, pule pra
   validação via chamada direta:
   `fetch('http://localhost:3000/api/retrabalho?os=99999&gtin=7898994680758').then(r=>r.json()).then(console.log)`
   no console do DevTools, e confirme que `fotos` agora tem 1 item com `arquivo` em base64.
4. Selecione manualmente (clicando na linha da tabela) o GTIN de teste, se ele estiver com status
   retrabalho — confirme que o painel amarelo aparece acima da área de captura, com a linha de
   motivo e a miniatura da foto.
5. Selecione outro GTIN (sem retrabalho) — confirme que o painel some.
6. Pare o servidor, confirme porta 3000 livre, e apague a pasta fake inteira:
   `Remove-Item -Recurse -Force "C:\SyncIMGSend\Retrabalho\OS_99999---(1 GTINs)---2026-08-01"`.

- [ ] **Step 9: Commit**

```bash
cd c:\sphoto-terminais
git add index.html js/app.js
git commit -m "feat: painel de retrabalho recebido na tela de captura"
```

---

## Post-plan: tag de versão e atualização de memória

Depois deste plano implementado, revisado e mergeado (fast-forward em `main`, já que os terminais
usam `git pull --ff-only`):

```bash
cd c:\sphoto-terminais
git tag v1.3.0
git push origin main --tags
```

(Confirmar com o usuário antes do `git push` — ação que afeta o repositório compartilhado que os
terminais físicos já usam pra atualizar sozinhos.)

Depois, atualizar a memória do projeto Syndi_qa (que hoje documenta o ciclo de retrabalho de
ponta a ponta) com: o lado RECEPÇÃO agora tem uma tela real no sphoto-terminais (não é mais
"o fotógrafo abre a pasta manualmente"), o caminho lido é `C:\SyncIMGSend\Retrabalho`, e a
regra RECEIVER do robô continua sendo o único pedaço pendente de instalação física. Isso é uma
atualização de memória, não uma tarefa de código — fazer na conversa de finalização, não como
step do plano.
