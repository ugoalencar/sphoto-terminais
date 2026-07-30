# Tela de retrabalho recebido na captura (sphoto-terminais)

## 0. Contexto

O ciclo de retrabalho hoje (2026-07-29) está parcialmente fechado: no lado do QA (Syndi_qa),
confirmar um retrabalho move a pasta do GTIN pra `Retrabalho\<pastaOsNome>\<gtin>\` e anexa uma
linha em `Retrabalho_OS_<numero>.txt` (na raiz da pasta da OS, não dentro da pasta do GTIN) —
feature já mergeada. Do lado do rob\u00f4 (`syncIMG.jar`), a regra SEND que pega essa pasta e
sobe pro bucket `WaitingConference/Retrabalho` já foi aplicada em produção na máquina do QA
(2026-07-29). A regra RECEIVER (que traria essa pasta de volta pra máquina do fotógrafo) está
especificada mas **ainda não instalada fisicamente** — sem acesso a essa máquina até agora.

O spec original de entrega (`Syndi_qa: docs/superpowers/specs/2026-07-29-syndi-qa-entrega-
retrabalho-fotografo-design.md`) tinha decidido explicitamente **não mexer em código do
sphoto-terminais** — o fotógrafo abriria a pasta manualmente no Explorer. Essa decisão está
sendo revista agora: os terminais físicos já usam o mecanismo de atualização via git
(`git pull --ff-only origin main`, botão "Verificar/Aplicar atualização" na engrenagem, já usado
antes com sucesso), então uma tela de verdade é viável de distribuir.

**Este spec cobre só o lado sphoto-terminais** (a tela). A regra RECEIVER do robô continua sendo
uma tarefa física separada, fora do alcance desta sessão — a tela é construída já apontando pro
caminho onde a regra vai entregar os arquivos quando for instalada, mas funciona (mostrando "sem
retrabalho pendente pra este GTIN") mesmo antes disso.

## 1. Decisões confirmadas com o usuário

- **Escopo**: construir uma tela nova de verdade (revisita a decisão "sem tela nova" do spec
  original) — não apenas configuração de robô.
- **Caminho de leitura**: `C:\SyncIMGSend\Retrabalho\<pastaOsNome>\` — mesmo caminho já
  especificado na regra RECEIVER (`PROCESSO_N_PASTA_DESTINO`) do spec do Syndi_qa. A tela fica
  pronta e só passa a mostrar dados reais quando a regra for instalada naquela máquina.
- **Conteúdo mostrado**: o texto dos motivos (linhas do `Retrabalho_OS_<numero>.txt` filtradas
  pra esse GTIN) **e** miniaturas das fotos que vieram do QA na pasta de retrabalho recebida —
  pra o fotógrafo comparar visualmente qual arquivo tem qual motivo antes de refazer.
- **Fluxo de refazer**: painel puramente informativo, sem ação de "concluir retrabalho". O
  fotógrafo fecha/ignora e refaz pelo MESMO fluxo de captura de sempre, pro mesmo GTIN. Nenhuma
  confirmação nova no servidor, nenhum botão dedicado.
- **Versionamento/rollback**: o repositório já usa tags semânticas (`v1.0.0`→`v1.2.0`, HEAD atual
  já é `v1.2.0` antes desta feature — serve como checkpoint natural). Depois do merge, nova tag
  `v1.3.0`. O mecanismo de atualização usa `git pull --ff-only`, que nunca anda pra trás sozinho
  — se algo precisar ser revertido depois, o caminho é `git revert` (commit novo desfazendo),
  nunca reescrever/forçar histórico pra trás (quebraria o `--ff-only` nos terminais já
  atualizados).

## 2. Arquitetura

**Novo módulo `lib/retrabalhoRecebido.js`** (não em `qaHub.js` — esse já é grande e serve a um
conceito diferente, o QA Hub local de conferência OCR/CR2, não a tela de captura do fotógrafo):

```js
function buscarRetrabalhoRecebido(os, gtin) {
    // 1. localiza a pasta decorada da OS em RETRABALHO_BASE (localizarPastaDecoradaPorPrefixo,
    //    importado de qaHub.js em vez de duplicado)
    // 2. le Retrabalho_OS_<os>.txt na raiz dessa pasta (se existir), filtra linhas que comecam
    //    com "<gtin> - "
    // 3. localiza a subpasta do gtin dentro da pasta da OS, lista fotos em base64
    //    (listarImagensBase64, ja existe em server.js - reutilizado, nao duplicado)
    // 4. se a pasta da OS ou do GTIN nao existir, devolve null (nao e erro)
}
```

`RETRABALHO_BASE = path.join(SYNCIMGSEND_BASE, 'Retrabalho')` — mesma constante `SYNCIMGSEND_BASE
= 'C:\\SyncIMGSend'` que `qaHub.js` já usa pros outros caminhos do robô (linha 95), mesmo padrão
"molde" documentado no spec do Syndi_qa (o robô resolve esse caminho relativo a onde o processo
roda, então o valor literal funciona mesmo a instalação real ficando em outro lugar).

`localizarPastaDecoradaPorPrefixo` passa a ser exportado de `qaHub.js` (hoje é função privada do
módulo) — evita duplicar a lógica de achar pasta decorada por prefixo numérico, já usada 2x hoje
(`buscarImagensEditadasRecebidas`).

**`server.js`**: nova rota `GET /api/retrabalho?os=&gtin=` — valida `os`/`gtin` com o mesmo padrão
de segurança já usado nas outras rotas (`isNomeSeguro`), chama `buscarRetrabalhoRecebido`, devolve
`{ ok: true, retrabalho: {...} | null }`.

**`js/app.js`**: em `selecionarGtin` (onde `buscarImagensOS()` já é chamado), se
`gtin.status === 'retrabalho'`, dispara também uma chamada a `/api/retrabalho`. Novo estado
`estado.retrabalhoRecebido` (`null` por padrão). Novo painel em `index.html`, `v-if`-gated (só
aparece se `estado.retrabalhoRecebido` não for `null`), posicionado acima da área de captura
normal: lista de linhas `arquivo: motivo1, motivo2` (parseadas do texto) + grade de miniaturas das
fotos recebidas. Ao trocar de GTIN (`selecionarGtin` de novo), o estado é resetado pra `null`
antes da nova busca — nunca mostra dado do GTIN anterior enquanto a nova busca está em voo.

## 3. Tratamento de erro

- Pasta/TXT/robô ainda não existem (RECEIVER não instalado, ou retrabalho ainda não chegou):
  `buscarRetrabalhoRecebido` devolve `null`, painel simplesmente não aparece. Não é uma condição
  de erro pro fotógrafo.
- Falha ao ler o TXT (ex.: permissão, arquivo corrompido) ou ao listar fotos: logada no servidor
  (`console.error`), rota ainda devolve `{ ok: true, retrabalho: null }` — mesmo efeito visual
  que "sem retrabalho pendente", nunca quebra a tela de captura por causa disso (mesmo princípio
  de "nunca bloquear a tela por uma falha num painel auxiliar" já usado no restante do projeto).

## 4. Testes

Sem framework de teste automatizado neste projeto (confirmado: não há testes em
`c:\sphoto-terminais` hoje). Verificação:
- `node --check` nos 3 arquivos alterados/criados (`lib/retrabalhoRecebido.js`, `server.js`,
  `js/app.js`).
- Teste manual criando uma pasta fake em `C:\SyncIMGSend\Retrabalho\OS_<n>...\<gtin>\` com um TXT
  e algumas fotos, selecionando esse GTIN na tela (com status retrabalho simulado) e confirmando
  que o painel aparece com o conteúdo certo; depois removendo a pasta e confirmando que o painel
  some sem erro.
- Teste real end-to-end (motivo + fotos reais vindas do robô) fica pendente até a regra RECEIVER
  ser instalada na máquina física — mesma situação de "verificação real pendente" já registrada
  no spec do Syndi_qa.

## 5. O que fica de fora

- Qualquer ação de "concluir retrabalho" ou mover/limpar a pasta recebida — decisão explícita do
  usuário, painel é só leitura.
- Instalar a regra RECEIVER do robô nessa máquina — ação física separada, fora do alcance desta
  sessão.
- Mudar o mecanismo de atualização (`--ff-only`) pra suportar rollback automático — fora de
  escopo; a estratégia de rollback é `git revert`, não uma mudança de mecanismo.
