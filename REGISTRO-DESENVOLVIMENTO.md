# Registro de Desenvolvimento — SPhoto

Registro do que foi construído, **por que** foi construído assim, e o que ficou pendente.
Última atualização: **15/07/2026**.

O `git log` conta o *que* mudou. Este arquivo existe pra contar o *porquê* — as decisões que
custaram discussão e que, sem registro, seriam refeitas errado daqui a alguns meses.

---

## 1. Os três pacotes

| Pasta | Pra quem | Tem Redmine? | Diferença principal |
|---|---|---|---|
| `C:\sphoto` | Máquina interna (estúdio/QA) | Sim | O QA revisa o **JPG final exportado do Lightroom** (`Finalizadas\OS_x\<gtin>`) |
| `C:\sphoto-terminais` | Estações dos fotógrafos | Sim | O QA revisa o **JPG da captura** (`Finalizadas\OCR\OS_x\<gtin>`) |
| `C:\sphoto-externo` | Fotógrafo externo | **Não** | Só GTIN (sem OS). Tudo cai em `OS_NONE\<gtin>`, jpg e cr2 na mesma pasta |

Fora do sphoto:
- `C:\FotografoExterno` — entrega S3 do fotógrafo externo (jar próprio, credenciais embutidas)
- `C:\Apps\Syncimg` — robô que sobe pro bucket `WaitingConference` (**não é nosso**, já existia)
- `C:\SyncIMGSend` — robô que manda pro editor (**não é nosso**)

---

## 2. Estrutura de pastas (o mapa mental que resolve 90% das dúvidas)

```
Finalizadas\
├── OCR\OS_49800\7894726071245\      ← JPG da captura (preview da câmera)
│   ├── foto_0.jpg
│   ├── RT\foto_2.jpg
│   └── IS\foto_5.jpg
└── OS_49800\7894726071245\          ← RAW (.cr2) + JPG final do Lightroom
    ├── foto_0.CR2
    ├── RT\foto_2.CR2
    └── IS\foto_5.CR2
```

**As duas pastas são gêmeas**: mesmo GTIN, mesmas subpastas, **mesmo nome-base** — só muda a
extensão. Essa simetria é a chave de quase tudo abaixo.

- **Captura** (`index.html`) mostra o lado **OCR**.
- **QA do sphoto principal** lê `OS_x\<gtin>` (espera o Lightroom exportar o JPG final).
- **QA do terminais** lê `OCR\OS_x\<gtin>` (o JPG da captura, que existe assim que salva).
- **Entrega** (AgEnvio) sai **sempre** de `OS_x\<gtin>` — o arquivo de verdade, nunca o preview.

---

## 3. O que foi feito

### 3.1 Fazer rodar em outra máquina

| Problema | Causa real | Solução |
|---|---|---|
| Botões não chamavam os `.bat` | `index.html` aberto por duplo-clique (`file://`) → CORS bloqueia o fetch pra `localhost` | Script de redirect no topo do HTML pra `http://localhost:3000/index.html` |
| "node não reconhecido" | Node não instalado | Instalação |
| WebSocket nunca conectava via `localhost:3000` | Usava `window.location.host` (porta 3000) em vez da 8099 do `start.jar` | Fixado `ws://<host>:8099/events/` |
| Servidor caía | `uncaughtException` mantinha o processo zumbi | `process.exit(1)` + loop de reinício no `iniciar-server.bat` |
| Plataforma não ficava conectada | Limite de 8KB de header do Jetty, estourado por cookies acumulados do Chrome | Perfil de navegador dedicado (`.perfil-navegador`) |

### 3.2 QA em branco no terminal (offline)

**Causa:** o Vue e o Bootstrap vinham de CDN (internet). A máquina do estúdio tem internet e
funcionava; o terminal não tem → o Vue nunca carregava → a tela do QA renderizava **vazia**.

**Solução:** tudo local — `js/vue.global.js`, `css/bootstrap-icons.css`, `css/fonts/*`.
Zero `https://` nos HTMLs.

**Efeito colateral:** as fontes davam 404 porque o CSS as referencia com `?hash` na URL e o
`server.js` não removia a query antes de procurar o arquivo. Corrigido (+ MIME de `.woff/.woff2`).

### 3.3 O pareamento JPG ↔ CR2 (bug real, corrigido nos 3 pacotes)

**O bug:** mover pra subpasta e deletar agiam **só no JPG**. O `.cr2` ficava órfão — o JPG ia
pro `RT\`, o RAW ficava na raiz; apagava a foto e o RAW continuava lá ocupando disco.

**A correção:** parear por **nome-base**. Qualquer ação no JPG pega o RAW irmão junto, quando
existir. Pontos corrigidos:

- `server.js` → `DELETE /api/imagem`, `POST /api/marcar`, `POST /api/tag-subpasta`
- `lib/qaHub.js` → `moverParaSubpasta` (passou a casar por nome-base), `handleMarcarQa`

**Testado:** 12 cenários por pacote (36 no total, 0 falhas) + 5 testes nos endpoints reais
(mover, deletar, toggle, marcar no temp, deletar no temp). Extensão maiúscula (`.CR2`) funciona.

### 3.4 O QA do terminais (decisão de produto)

**Sintoma:** `/api/qa/tree` devolvia `{"os":[]}` no terminais, mesmo com fotos.

**Causa:** não era bug. O QA lia `OS_49800\<gtin>`, que tinha **só `.CR2`** — e o filtro esconde
GTIN sem JPG (*"Lightroom ainda não exportou, não há o que revisar"*). Os JPGs da captura estavam
na pasta `OCR\`, que o QA ignorava de propósito.

**Decisão:** no **terminais** (estação do fotógrafo), o QA passou a trabalhar no lado **OCR**
(JPG leve), e **todo comando espelha no `.CR2`** da pasta gêmea:

| Comando do QA (terminais) | Espelha no CR2 |
|---|---|
| Mover pra RT/IS/AP | Sim |
| Marcar `_coding` | Sim |
| Destino Mockup/Recorte | Sim |
| **Entrega (AgEnvio)** | **Lê do RAW** — nunca manda preview |

Implementado com `PASTA_QA_BASE` (= `Finalizadas\OCR`) e `pastaGtinRaw()` no
`sphoto-terminais/lib/qaHub.js`. **O sphoto principal não foi alterado** — lá o QA revisa o
JPG final do Lightroom, que é a função dele.

### 3.5 O preview embutido no CR2 (a descoberta que mudou o rumo)

Todo CR2 já carrega JPEGs prontos dentro dele. Medido nas fotos reais:

| | Resolução | Tamanho |
|---|---|---|
| JPG que a câmera grava | 6240x4160 | **20,3 MB** |
| Preview **embutido no CR2** | 6240x4160 | **1,7 MB** |
| Thumbnail embutido no CR2 | 160x120 | 9 KB |

**Mesma resolução, 12x mais leve, de graça.** Comparado em 1:1 na letra miúda do rótulo: o
preview embutido é **igual ou melhor** (menos granulado que o JPG da câmera).

Extrair **não é decodificar RAW** — é recorte de bytes, ~20 ms por foto, **zero dependência**
(nada de dcraw/libraw/ImageMagick pra instalar em cada máquina).

> **Armadilha do formato:** os dados do sensor também são gravados dentro do CR2 como
> *lossless JPEG* (27 MB) e aparecem numa varredura ingênua de marcadores — mas **não são foto**.
> Distinguem-se pelo SOF: `SOF0/1/2` + 3 componentes = foto; `SOF3` + 4 componentes = sensor.
> O `lib/cr2Preview.js` filtra por isso e pega o **maior preview visualizável**.

### 3.6 OCR pro Cadastro

**O contexto:** o JPG de OCR não é descarte — é **entregável** pro pessoal do cadastro, que usa
pra registrar o produto sem esperar a edição. Quando a demanda é pequena, o estúdio de RAW faz
esse trabalho também.

**O que foi construído:**

| Arquivo | O que faz |
|---|---|
| `lib/cr2Preview.js` | Extrai o JPEG embutido do CR2 |
| `lib/ocrCadastro.js` | Gera os JPG e copia pra pasta do Cadastro |
| `ocr-config.json` | Configuração (caminho, estrutura) — **editável sem tocar em código** |
| `server.js` | `POST /api/ocr/gerar` (aceita lista de arquivos ou o GTIN inteiro) |
| `index.html` + `css` | Checkbox **OCR** (no topo) e **`_ocr`** (por foto) |
| `js/app.js` | Ao Salvar/Finalizar com OCR ligado, gera e copia |

**As regras:**

| Situação | O que acontece |
|---|---|
| Checkbox OCR ligado, nenhuma foto marcada | Vai o **GTIN inteiro** (caso comum — OCR precisa de várias fotos) |
| Alguma foto marcada com `_ocr` | Vão **só as marcadas** |
| Foto em `RT` **e** marcada `_ocr` | Fica no RT no Finalizadas **e** vira JPG no Cadastro |

**Testado:** 8 fotos em ~1s, resolução cheia, 9,5 MB (os JPGs da câmera dariam ~160 MB).
GTIN sem RAW → 404 com mensagem clara. Foto dentro do RT + marcada `_ocr` → só ela, nome limpo.

---

## 4. Decisões e o porquê (não refazer sem ler)

### 4.1 O `_ocr` é sufixo, não subpasta

`RT/IS/AP` são **mutuamente exclusivas** — o arquivo só fica em uma por vez. Se o OCR fosse uma
delas, marcar OCR **tiraria a foto do RT**. E a mesma foto pode ser de edição **e** de OCR.

Como sufixo (igual ao `_coding`), as duas coisas convivem. E não há conflito estrutural porque
**a regra de subpasta vale só no Finalizadas** — no Cadastro vai tudo solto.

### 4.2 O sphoto NÃO escreve o status do OCR no Redmine

Quem muda `Foto (OCR)` de *Aguardando Início* → *Concluído* é o **robô do Cadastro**, que roda
em outra máquina e já funciona.

**Por quê:** o status tem que dizer a verdade. "Concluído" significa *o cadastro tem o arquivo* —
só o robô sabe disso, porque ele marca **depois** de subir. Se o sphoto marcasse na hora de
**copiar**, bastaria o robô estar parado ou a rede cair pro Redmine mentir: diz entregue, e o
cadastro não recebeu nada.

**Precedente:** essa decisão já era do projeto, está escrita no `qaHub.js`:
> *"o robô mesmo muda pra 'Ag. Conferência' depois do upload. **Por isso o QA Hub só grava os
> campos extras DEPOIS que o robô já rodou — não mexemos na Situação das Imagens nessa etapa.**"*

**Quem entrega é dono do status.** Dois donos do mesmo campo = corrida.

### 4.3 Falha no OCR não derruba o Salvar

As fotos já estão salvas; aparece um aviso *"OCR não foi gerado: … (as fotos foram salvas)"*.
Como o preview mora dentro do CR2, dá pra refazer depois. **Nunca se perde o trabalho do
fotógrafo por causa da rede.**

### 4.4 Redmine: OCR e fotografia são campos independentes

| Campo | Valores |
|---|---|
| `cf_15` — Situação das Imagens | Aguardando Fotografia (18), Aguardando QA Fotografia (19), Aguardando Edição (20), Ag. Conferência (154)… |
| `cf_16` — **Foto (OCR)** | Aguardando Início (26), Em andamento (27), **Concluído (28)**, Não aplicável (130) |

São **trilhos paralelos** — um GTIN pode estar "Aguardando Início" no OCR **e** "Aguardando
Fotografia" ao mesmo tempo. Um não bloqueia o outro. Tratar um campo como se servisse aos dois
fluxos é a origem da sensação de "ter que trocar o conector".

Observação: os **8 conectores** existentes condicionam **só** em "Situação das Imagens".
**Nenhum toca em "Foto (OCR)"**. O motor de regras é genérico (condiciona em qualquer
`REDMINE_CUSTOM_FIELD` pelo nome), então um conector de OCR é possível — mas hoje não existe.

---

## 5. O fluxo do "enviar para conferência" (investigado, funciona)

```
1. sphoto copia   Finalizadas\OS_x\<gtin>  →  C:\Apps\Syncimg\Fotografados\AgEnvio\OS_x\<gtin>
2. sphoto abre o terminal e roda o syncIMG.jar
3. robô sobe cada arquivo  →  bucket WaitingConference
4. robô MOVE o que subiu   →  Fotografados\Enviadas\OS_x\<gtin>
```

O AgEnvio é **fila**: o que sobe sai de lá. `Enviadas` cheio + `AgEnvio` vazio = deu certo.

**"Enviar OS"** = o mesmo, na OS toda (dispara o robô uma vez no final), com dois filtros que
**pulam GTINs em silêncio**:
- já marcado como enviado (`sphoto-qa-enviado.json`)
- sem nenhum JPG na raiz

> **Nota:** `WaitingConference` é o bucket daqui (`C:\Apps\Syncimg\ini.conf`).
> `work-in-progress-post-production` é do `D:\synd_externo` — robô do **fotógrafo externo**,
> outra coisa.

---

## 6. Armadilhas conhecidas

1. **Deixe o terminal do robô aberto até terminar.** Em 15/07 um envio parou no meio (3 de 8
   arquivos) porque o processo morreu. O bat termina com `pause` — quando aparecer *"Pressione
   qualquer tecla"*, aí sim pode fechar.
   **Risco associado:** se o robô parar **depois** de já ter mudado o status pra "Ag. Conferência",
   ao rodar de novo ele **ignora** o GTIN (a condição da regra não bate mais) e os arquivos que
   faltam ficam órfãos — Redmine dizendo "entregue", metade das fotos nunca enviada.

2. **`ocr-config.json` → `pastaCadastro` é um palpite.** O `\\192.168.2.201` não estava acessível
   quando foi configurado. **Confira antes de usar em produção.**

3. **Uma porta 3000 só.** Se o sphoto principal e o terminais rodarem na mesma máquina, um dos
   dois não sobe (`EADDRINUSE`) e a interface do outro conversa com o servidor errado — sintoma
   confuso, dados de outra pasta aparecendo.

4. **O OCR gera o GTIN inteiro, não só o palco.** Salvar em duas tacadas com o checkbox ligado só
   na segunda faz a primeira ir junto. É idempotente (sobrescreve), mas não é "só o palco".

5. **Cache do navegador.** Depois de atualizar arquivos, **Ctrl+Shift+R** — senão o HTML velho
   continua rodando e parece que a correção não funcionou.

---

## 7. Pendências

- [ ] **Confirmar o caminho do Cadastro** no `ocr-config.json` (o único bloqueio real do OCR).
- [ ] Botão **"Gerar OCR do GTIN"** retroativo — pra quando esquecerem de marcar. O endpoint já
      aceita lista de arquivos; falta só o botão.
- [ ] Avisos de silêncio no QA:
      - *"enviei 7 de 10 GTINs — 3 pulados (sem JPG)"*
      - *"GTIN xxx: 5 arquivos ainda no AgEnvio, não subiram"*
      - `Foto (OCR)` do Redmine em modo leitura (avisa quando o robô vai ignorar o GTIN)
- [ ] **Miniaturas no QA.** Hoje a tela embute a imagem inteira em base64 — um GTIN de 6 fotos
      carrega ~105 MB. Usar o thumbnail de 9 KB (embutido no CR2) na grade e a imagem cheia só
      ao ampliar deixaria instantâneo.
- [ ] **Decisão em aberto:** desligar o JPG da câmera e ir de RAW-only (o preview embutido cobre
      visualização **e** OCR). Elimina 20 MB por foto **e** a classe inteira de bug de pareamento —
      um arquivo só não tem como dessincronizar. Fazer **em etapas**, com fallback, e só depois do
      cadastro aprovar o OCR gerado.

---

## 8. Detalhe que ficou pendente de conferir

A câmera do terminal está gravando JPG em **resolução cheia, 20,3 MB** (6240x4160) — não é a
configuração de "JPG de baixa resolução só pra visualização" que se esperava. São 20 MB por foto
gravados e depois descartados. **Vale conferir a configuração da câmera**, independente de
qualquer decisão sobre RAW-only.
