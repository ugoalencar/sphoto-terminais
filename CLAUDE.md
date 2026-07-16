# SPhoto — Terminal do Fotógrafo

Estação de captura de fotos de produto. Node + Vue (sem build, sem npm install) + `start.jar`
(Java/Jetty) + câmera Canon via `simplusCamera.exe`.

**Esta máquina roda offline.** Nada de CDN, nada que dependa de internet pra abrir a tela.

---

## ⚡ Se algo não funciona, comece AQUI

```
diagnostico.bat
```

Ele gera `diagnostico.txt` com Java, Node, portas, processos e os logs — **em um passo só**.
Leia esse arquivo **antes de formular qualquer hipótese**. Já perdemos horas caçando causa
errada (Java, versão do jar, cookies) enquanto a resposta estava no log o tempo todo.

**Os bats rodam escondidos** (sem janela). Então erro nenhum aparece na tela — vai tudo pra:
- `logs\start.log` — a Plataforma (Java/start.jar)
- `logs\server.log` — o Servidor (Node)
- `logs\camera.log` — a Câmera

---

## As 3 peças

| Peça | O que é | Porta | Log |
|---|---|---|---|
| **Servidor** | `node server.js` | 3000 | `logs\server.log` |
| **Plataforma** | `java -jar start.jar` (Jetty) — busca GTIN no Redmine via WebSocket | **8099** | `logs\start.log` |
| **Câmera** | `simplusCameraLib\simplusCamera.exe` | — | `logs\camera.log` |

- **Ligar:** atalho do SPhoto (ou `launcher.js`) — sobe tudo e abre as telas
- **Parar:** `parar.bat` (só mata processo do sphoto, não mexe em outros java/node)
- **Monitor:** `monitor.html` — mostra o estado das 3

---

## Estrutura de pastas (o mapa que resolve 90% das dúvidas)

```
Finalizadas\
├── OCR\OS_x\<gtin>\      ← JPG da captura   ← O QA DESTE PACOTE LÊ AQUI
└── OS_x\<gtin>\          ← RAW (.cr2)
```

**São gêmeas**: mesmo GTIN, mesmas subpastas (RT/IS/AP), **mesmo nome-base**, só muda a extensão.

Regras que valem ouro:
1. **Neste pacote (terminais)** o QA trabalha no lado **OCR** (jpg leve) e **espelha todo
   comando no `.cr2`** da gêmea. Ver `PASTA_QA_BASE` e `pastaGtinRaw()` em `lib/qaHub.js`.
   (No `c:\sphoto` principal é diferente: lá o QA lê o JPG final do Lightroom.)
2. **Qualquer ação em foto pega o par jpg+cr2 junto** (mover, deletar, marcar sufixo).
   Casamento por **nome-base**. Ver `paresNaPasta()` / `moverParaSubpasta()` em `lib/qaHub.js`.
3. **A entrega (AgEnvio) sai SEMPRE do lado RAW** — nunca manda o preview da OCR.
4. **RAW-only funciona**: a câmera pode gravar só `.cr2`. Todo CR2 carrega um **JPEG de preview
   embutido** (mesma resolução, ~12x mais leve) — é ele que a tela exibe. Ver `lib/cr2Preview.js`.
   ⚠️ O CR2 também guarda os **dados do sensor como "lossless JPEG"** (27 MB, `SOF3`, 4 componentes) —
   **não é foto**. O extrator filtra por `SOF0/1/2` + 3 componentes. Não "simplifique" isso.

---

## 🐛 Problemas conhecidos (leia antes de debugar)

| Sintoma | Causa real |
|---|---|
| **Plataforma conecta e cai** | Jetty derruba WebSocket ocioso em **5 min** (`Idle timeout expired: 300000 ms`, close 1001). Já tratado: o `onclose` reconecta em 3s e a tela só avisa depois de `TOLERANCIA_RECONEXAO_MS` (9s), pra não piscar. **Não invente um "ping"** — o protocolo do `start.jar` é de comandos (`LIMPAR_TEMP`…), mensagem desconhecida pode quebrar. |
| **Câmera em RAW-only e o palco vazio** | Já tratado: `listImages`/`listarImagensBase64`/ETag/handler estático aceitam `.cr2` e servem o **JPEG embutido** (`lib/cr2Preview.js`, `bytesParaExibir()`). Se voltar a sumir, é aí. |
| **QA abre em branco** | Falta `js/vue.global.js` ou `css/bootstrap-icons.css`. Sem Vue, a tela não renderiza. **Não pode depender de CDN.** |
| **QA não lista OS** | O GTIN precisa ter **JPG** — só `.CR2` na pasta = escondido de propósito. |
| **Botão não chama o .bat** | Abriu o HTML por duplo-clique (`file://`) → CORS. Tem que ser `http://localhost:3000`. |
| **Correção "não funcionou"** | Cache do navegador. **Ctrl+Shift+R.** |
| **Porta 3000 ocupada** | Outro sphoto rodando. A interface conversa com o servidor errado — sintoma confuso. |
| **Ícones/fontes 404** | O CSS pede a fonte com `?hash`; o `server.js` tira a query antes de resolver. |

---

## ⛔ Não faça

- **Não coloque nada de CDN** nos HTMLs (Vue, Bootstrap, ícones). Esta máquina é offline.
- **Não mexa na `Situação das Imagens` do Redmine** durante a entrega. Quem entrega é dono
  do status: o robô syncIMG muda sozinho **depois** de subir. Marcar antes = Redmine mentindo.
- **Não feche o terminal do robô** no meio de um envio (`enviar para conferência`). Espere o
  *"Pressione qualquer tecla"*. Fechar no meio deixa arquivo pra trás em silêncio.
- **Não faça o `moverParaSubpasta` casar por nome exato** — tem que ser por nome-base, senão
  o `.cr2` fica órfão.

---

## Contexto e decisões

**`REGISTRO-DESENVOLVIMENTO.md`** (nesta pasta) tem o histórico completo: o que foi feito,
**por que** foi feito assim, as armadilhas e as pendências. Leia antes de desfazer qualquer
decisão que pareça estranha — a maioria tem motivo registrado.

## Estilo

- Comentário em código: explica **por quê**, não o quê. Português, sem acento (o resto do
  código é assim).
- Sem framework novo, sem build, sem dependência nova. O valor deste pacote é **copiar a pasta
  e rodar**.
