const { createApp, ref, reactive, onMounted } = Vue;

const CAMPOS_IDS = ['15', '23', '176', '175'];
const API = 'http://localhost:3000';

createApp({
    setup() {
        const viewAtiva = ref('fila'); // 'fila' | 'agenda'

        const arvore = ref([]);
        const carregandoArvore = ref(false);
        const erroArvore = ref('');

        const agenda = ref([]);
        const carregandoAgenda = ref(false);
        const erroAgenda = ref('');
        let agendaCarregadaAlgumaVez = false;

        const gtinSelecionado = ref(null); // { os, gtin }
        const abaAtiva = ref('foto');
        const carregandoDetalhe = ref(false);
        const detalhe = ref(null);
        const marcandoDestino = ref(false);
        const gerandoOcr = ref(false);
        const finalizando = ref(false);
        const mensagemFinalizar = ref('');
        const erroFinalizar = ref('');
        const enviandoConferencia = ref(false);
        const mensagemConferencia = ref('');
        const erroConferencia = ref('');
        const enviandoConferenciaOs = ref(null); // os que esta enviando agora, ou null
        const mensagemConferenciaOs = reactive({});
        const erroConferenciaOs = reactive({});
        const iniciandoRecebimento = ref(false);
        const mensagemRecebimento = ref('');
        const erroRecebimento = ref('');

        const opcoesSituacao = ref({});
        const opcoesResponsavel = ref({});

        const campos = reactive({});
        const origemCampo = reactive({});

        const conflito = ref(null);
        const enviando = ref(false);
        const mensagem = ref('');
        const erroEnvio = ref('');

        async function carregarOpcoesRedmine() {
            try {
                const resp = await fetch(API + '/redmine-campos.json');
                const dados = await resp.json();
                opcoesSituacao.value = dados.campos.cf_15.opcoes;
                opcoesResponsavel.value = dados.campos.cf_23.opcoes;
            } catch (err) {
                console.error('Erro ao carregar redmine-campos.json:', err);
            }
        }

        async function carregarArvore() {
            carregandoArvore.value = true;
            erroArvore.value = '';
            try {
                const resp = await fetch(API + '/api/qa/tree');
                const dados = await resp.json();
                if (!dados.ok) throw new Error(dados.error || 'Erro desconhecido');
                arvore.value = dados.os;
            } catch (err) {
                erroArvore.value = 'Erro ao carregar lista: ' + err.message + ' (server.js rodando?)';
            } finally {
                carregandoArvore.value = false;
            }
        }

        async function carregarAgenda() {
            carregandoAgenda.value = true;
            erroAgenda.value = '';
            try {
                const resp = await fetch(API + '/api/qa/agenda-edicao');
                const dados = await resp.json();
                if (!dados.ok) throw new Error(dados.error || 'Erro desconhecido');
                agenda.value = dados.itens;
                agendaCarregadaAlgumaVez = true;
            } catch (err) {
                erroAgenda.value = 'Erro ao carregar agenda: ' + err.message + ' (server.js rodando?)';
            } finally {
                carregandoAgenda.value = false;
            }
        }

        function mudarParaAgenda() {
            viewAtiva.value = 'agenda';
            if (!agendaCarregadaAlgumaVez) carregarAgenda();
        }

        // O nome completo (GTIN_dd_mm_aaaa_hh_mm_ss_indice[_sufixo].ext) e enorme e repete
        // o GTIN em toda miniatura da mesma pasta - mostra so a parte que distingue
        // (indice + sufixo + extensao), nome completo continua no title (tooltip).
        function nomeCurto(nome) {
            const m = nome.match(/^\d+_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}_\d{2}_(\d+(?:_[a-zA-Z0-9]+)*\.[a-zA-Z0-9]+)$/);
            return m ? m[1] : nome;
        }

        function valorAtualDoCampo(issue, id) {
            if (!issue) return null;
            const cf = issue.custom_fields.find(c => String(c.id) === id);
            return cf ? cf.value : null;
        }

        // Aplica um /api/qa/gtin novo no estado. Campos que o usuario ja editou
        // manualmente nesta sessao (origemCampo === 'manual') nao sao sobrescritos -
        // so os que ainda sao "palpite" acompanham a pasta ao vivo.
        function aplicarDetalhe(dados) {
            detalhe.value = dados;
            CAMPOS_IDS.forEach(id => {
                if (origemCampo[id] === 'manual') return;
                const valorRedmine = valorAtualDoCampo(dados.issue, id);
                if (valorRedmine) {
                    campos[id] = valorRedmine;
                    origemCampo[id] = 'manual';
                } else if (dados.camposSugeridos[id] !== undefined) {
                    campos[id] = dados.camposSugeridos[id];
                    origemCampo[id] = 'inferido';
                } else {
                    campos[id] = campos[id] || '';
                    origemCampo[id] = 'inferido';
                }
            });
        }

        async function buscarDetalhe(os, gtin) {
            const resp = await fetch(API + '/api/qa/gtin?os=' + encodeURIComponent(os) + '&gtin=' + encodeURIComponent(gtin));
            const dados = await resp.json();
            if (!dados.ok) throw new Error(dados.error || 'Erro desconhecido');
            return dados;
        }

        function ehSelecaoAtual(os, gtin) {
            return !!gtinSelecionado.value && gtinSelecionado.value.os === os && gtinSelecionado.value.gtin === gtin;
        }

        async function selecionarGtin(os, gtin) {
            gtinSelecionado.value = { os, gtin };
            carregandoDetalhe.value = true;
            detalhe.value = null;
            conflito.value = null;
            mensagem.value = '';
            erroEnvio.value = '';
            CAMPOS_IDS.forEach(id => { campos[id] = ''; origemCampo[id] = 'inferido'; });

            try {
                const dados = await buscarDetalhe(os, gtin);
                // Se o usuario ja trocou de GTIN enquanto isso carregava, descarta -
                // senao uma resposta atrasada de um GTIN antigo sobrescreve o atual.
                if (!ehSelecaoAtual(os, gtin)) return;
                aplicarDetalhe(dados);
            } catch (err) {
                if (!ehSelecaoAtual(os, gtin)) return;
                erroEnvio.value = 'Erro ao carregar GTIN: ' + err.message;
            } finally {
                if (ehSelecaoAtual(os, gtin)) carregandoDetalhe.value = false;
            }
        }

        async function recarregarDetalheAtual() {
            if (!gtinSelecionado.value) return;
            const { os, gtin } = gtinSelecionado.value;
            try {
                const dados = await buscarDetalhe(os, gtin);
                if (!ehSelecaoAtual(os, gtin)) return;
                aplicarDetalhe(dados);
            } catch (err) {
                console.error('Erro ao recarregar detalhe:', err);
            }
        }

        function marcarTocado(id) {
            origemCampo[id] = 'manual';
        }

        async function toggleCoding(img) {
            try {
                const resp = await fetch(API + '/api/qa/marcar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        os: gtinSelecionado.value.os,
                        gtin: gtinSelecionado.value.gtin,
                        arquivos: [img.nome],
                        sufixo: '_coding'
                    })
                });
                const dados = await resp.json();
                if (!resp.ok) throw new Error(dados.error || ('HTTP ' + resp.status));
                await recarregarDetalheAtual();
            } catch (err) {
                alert('Erro ao marcar _coding: ' + err.message);
            }
        }

        async function toggleSubpasta(nome, pasta) {
            try {
                const resp = await fetch(API + '/api/qa/tag-subpasta', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        os: gtinSelecionado.value.os,
                        gtin: gtinSelecionado.value.gtin,
                        arquivos: [nome],
                        pasta
                    })
                });
                const dados = await resp.json();
                if (!resp.ok) throw new Error(dados.error || ('HTTP ' + resp.status));
                await recarregarDetalheAtual();
            } catch (err) {
                alert('Erro ao mover para ' + pasta + ': ' + err.message);
            }
        }

        // OCR de UMA foto - mesmo motor do botao OCR do palco Anterior (index.html). Gera o JPG
        // a partir do preview embutido no RAW, grava em Finalizadas\OCR\OS_x\<gtin> e copia pra
        // fila do Cadastro (\\servidor\Cadastro\OCR), onde o robo de la trata.
        //
        // Nao move nem apaga nada: a foto continua exatamente onde esta (raiz ou subpasta) -
        // por isso convive com RT/IS/AP. Usar quando o trabalho e edicao E OCR. Quando e SO OCR,
        // o caminho e o checkbox OCR do topo do index.html, que dispensa o RAW.
        async function gerarOcr(nome) {
            if (!gtinSelecionado.value || gerandoOcr.value) return;
            gerandoOcr.value = true;
            try {
                const resp = await fetch(API + '/api/ocr/gerar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        os: gtinSelecionado.value.os,
                        gtin: gtinSelecionado.value.gtin,
                        arquivos: [nome]
                    })
                });
                const dados = await resp.json();
                if (!resp.ok) throw new Error(dados.erro || dados.error || ('HTTP ' + resp.status));
                if ((dados.falhas || []).length > 0) {
                    throw new Error(dados.falhas[0].motivo);
                }

                // A copia pra rede e best-effort: se falhar, o OCR local ja saiu - mas quem esta
                // na tela PRECISA saber que nao chegou no Cadastro, senao acha que entregou.
                const cad = dados.cadastro;
                if (cad && cad.falharam > 0) {
                    alert('OCR gerado localmente, mas NAO foi pro Cadastro:\n' +
                        (cad.motivo || 'rede fora') + '\n\nDa pra reenviar depois.');
                } else if (cad && cad.copiados > 0) {
                    alert('OCR gerado e enviado pro Cadastro.');
                } else {
                    alert('OCR gerado (copia pro Cadastro desligada no ocr-config.json).');
                }
                await recarregarDetalheAtual();
            } catch (err) {
                alert('Erro ao gerar OCR: ' + err.message);
            } finally {
                gerandoOcr.value = false;
            }
        }

        // Marca/desmarca manualmente o destino Brasil (Mockup ou Recorte) - clicar no
        // que ja esta ativo desmarca, clicar no outro troca (o backend cuida de nao
        // deixar os dois marcados ao mesmo tempo). A subpasta criada e so o sinal pra
        // inferirCampos() - os arquivos continuam soltos na raiz, contagem automatica.
        async function marcarDestinoManual(tag) {
            if (!gtinSelecionado.value || !detalhe.value || marcandoDestino.value) return;
            const jaAtivo = tag in detalhe.value.imagens.subpastas;
            const novoTipo = jaAtivo ? null : tag;

            marcandoDestino.value = true;
            try {
                const resp = await fetch(API + '/api/qa/marcar-destino', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        os: gtinSelecionado.value.os,
                        gtin: gtinSelecionado.value.gtin,
                        tipo: novoTipo
                    })
                });
                const dados = await resp.json();
                if (!resp.ok) throw new Error(dados.error || ('HTTP ' + resp.status));
                if (dados.avisos && dados.avisos.length) alert(dados.avisos.join('\n'));
                await recarregarDetalheAtual();
                await carregarArvore();
            } catch (err) {
                alert('Erro ao marcar destino: ' + err.message);
            } finally {
                marcandoDestino.value = false;
            }
        }

        // Fallback pro botao Finalizar do index.html (que precisa do start.jar rodando) -
        // grava direto via Redmine REST Situacao=Aguardando QA Fotografia + Data
        // Fotografia=hoje, sem depender do websocket. Clicar de novo nao faz mal (so
        // regrava o mesmo valor).
        async function finalizarGtin() {
            if (!gtinSelecionado.value || finalizando.value) return;
            finalizando.value = true;
            mensagemFinalizar.value = '';
            erroFinalizar.value = '';
            try {
                const resp = await fetch(API + '/api/qa/finalizar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        os: gtinSelecionado.value.os,
                        gtin: gtinSelecionado.value.gtin
                    })
                });
                const dados = await resp.json();
                if (!resp.ok) throw new Error(dados.error || ('HTTP ' + resp.status));
                mensagemFinalizar.value = 'Finalizado - Situação das Imagens gravada como "Aguardando QA Fotografia".';
            } catch (err) {
                erroFinalizar.value = 'Erro ao finalizar: ' + err.message;
            } finally {
                finalizando.value = false;
            }
        }

        // Copia a pasta pro robo Syncimg (C:\Apps\Syncimg\Fotografados\AgEnvio) e aciona
        // o .bat que sobe pro S3 - so funciona se a Situacao das Imagens no Redmine
        // estiver "Aguardando QA Fotografia" (o robo confere isso sozinho). Nao mexe em
        // nenhum campo do Redmine aqui - isso fica pra aba QA para Edicao, depois que o
        // robo ja tiver rodado e trocado a situacao pra "Ag. Conferência".
        async function enviarParaConferencia() {
            if (!gtinSelecionado.value || enviandoConferencia.value) return;
            enviandoConferencia.value = true;
            mensagemConferencia.value = '';
            erroConferencia.value = '';
            try {
                const resp = await fetch(API + '/api/qa/enviar-conferencia', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        os: gtinSelecionado.value.os,
                        gtin: gtinSelecionado.value.gtin
                    })
                });
                const dados = await resp.json();
                if (!resp.ok) throw new Error(dados.error || ('HTTP ' + resp.status));
                mensagemConferencia.value = 'Copiado e robô acionado - acompanhe a Situação das Imagens no Redmine (deve virar "Ag. Conferência" em alguns minutos).';
            } catch (err) {
                erroConferencia.value = 'Erro ao enviar para conferência: ' + err.message;
            } finally {
                enviandoConferencia.value = false;
            }
        }

        // Envia a OS inteira de uma vez (caso comum: fotografo termina tudo e entrega
        // junto) - mesma copia+robo do envio por GTIN, so que pra todos os GTINs
        // pendentes daquela OS numa tacada so.
        async function enviarOsParaConferencia(os) {
            if (enviandoConferenciaOs.value) return;
            enviandoConferenciaOs.value = os;
            delete mensagemConferenciaOs[os];
            delete erroConferenciaOs[os];
            try {
                const resp = await fetch(API + '/api/qa/enviar-conferencia-os', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ os })
                });
                const dados = await resp.json();
                if (!resp.ok) throw new Error(dados.error || ('HTTP ' + resp.status));
                mensagemConferenciaOs[os] = dados.gtinsCopiados.length === 0
                    ? 'Nada pendente pra enviar nesta OS.'
                    : dados.gtinsCopiados.length + ' GTIN(s) copiados e robô acionado.';
            } catch (err) {
                erroConferenciaOs[os] = 'Erro ao enviar OS: ' + err.message;
            } finally {
                enviandoConferenciaOs.value = null;
            }
        }

        // Liga a instancia propria do syncIMG (dentro do sphoto) que fica de olho no
        // bucket EditingDone e traz o que o editor ja terminou pra AguardandoQA. So
        // precisa ser ligada uma vez (fica rodando) - ver syncimg-qa-edicao/ini.conf.
        async function iniciarRecebimentoQaEdicao() {
            if (iniciandoRecebimento.value) return;
            iniciandoRecebimento.value = true;
            mensagemRecebimento.value = '';
            erroRecebimento.value = '';
            try {
                const resp = await fetch(API + '/api/qa/iniciar-recebimento-qa-edicao', { method: 'POST' });
                const dados = await resp.json();
                if (!resp.ok) throw new Error(dados.error || ('HTTP ' + resp.status));
                mensagemRecebimento.value = 'Robô de recebimento acionado - acompanhe a pasta AguardandoQA.';
            } catch (err) {
                erroRecebimento.value = 'Erro ao iniciar robô: ' + err.message;
            } finally {
                iniciandoRecebimento.value = false;
            }
        }

        async function confirmarEnvio(forcar) {
            if (!detalhe.value || !detalhe.value.issue) return;
            enviando.value = true;
            mensagem.value = '';
            erroEnvio.value = '';
            conflito.value = null;

            const payload = {
                os: gtinSelecionado.value.os,
                gtin: gtinSelecionado.value.gtin,
                issueId: detalhe.value.issue.id,
                updatedOnConhecido: detalhe.value.issue.updated_on,
                forcar: !!forcar,
                campos: Object.fromEntries(CAMPOS_IDS.map(id => [id, campos[id]]))
            };

            try {
                const resp = await fetch(API + '/api/qa/redmine/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const dados = await resp.json();

                if (resp.status === 409) {
                    conflito.value = dados;
                    return;
                }
                if (!resp.ok) throw new Error(dados.error || ('HTTP ' + resp.status));

                mensagem.value = dados.encaminhadoParaEditor
                    ? 'Enviado com sucesso! Copiado e robô do editor (SyncIMGSend) acionado. Este GTIN saiu da lista.'
                    : 'Enviado com sucesso! Este GTIN saiu da lista.';
                const osAtual = gtinSelecionado.value.os;
                const gtinAtual = gtinSelecionado.value.gtin;
                gtinSelecionado.value = null;
                detalhe.value = null;
                await carregarArvore();
            } catch (err) {
                erroEnvio.value = 'Erro ao enviar: ' + err.message;
            } finally {
                enviando.value = false;
            }
        }

        onMounted(() => {
            carregarOpcoesRedmine();
            carregarArvore();
        });

        return {
            nomeCurto,
            viewAtiva, mudarParaAgenda,
            agenda, carregandoAgenda, erroAgenda, carregarAgenda,
            arvore, carregandoArvore, erroArvore, carregarArvore,
            gtinSelecionado, abaAtiva, carregandoDetalhe, detalhe,
            opcoesSituacao, opcoesResponsavel,
            campos, origemCampo, marcarTocado,
            conflito, enviando, mensagem, erroEnvio,
            marcandoDestino, marcarDestinoManual,
            finalizando, mensagemFinalizar, erroFinalizar, finalizarGtin,
            enviandoConferencia, mensagemConferencia, erroConferencia, enviarParaConferencia,
            enviandoConferenciaOs, mensagemConferenciaOs, erroConferenciaOs, enviarOsParaConferencia,
            iniciandoRecebimento, mensagemRecebimento, erroRecebimento, iniciarRecebimentoQaEdicao,
            gerandoOcr, gerarOcr,
            selecionarGtin, toggleCoding, toggleSubpasta, confirmarEnvio
        };
    }
}).mount('#qaApp');
