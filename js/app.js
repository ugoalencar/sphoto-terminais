const { createApp, reactive, onMounted, onUnmounted, watch } = Vue;

const app = createApp({
    setup() {
        const estado = reactive({
            conectado: false,
            cameraConectada: false,
            cameraDesligada: localStorage.getItem('cameraDesligada') === '1',
            websocket: null,
            origem: 'GET_GTIN',

            gtinAtual: 'NONE',
            descricaoProduto: '...',
            osAtual: 'NONE',
            qtdeGtins: 0,
            demandaId: 0,

            listaGtins: [],
            gtinAtivoIndex: -1,

            imagensAnterior: [],
            imagensAtual: [],
            imagemSelecionada: null,
            tipoSelecionado: null,
            imagensMarcadas: [],
            imagensMarcadasAnterior: [],
            subpastasAnterior: { RT: [], IS: [], AP: [] },

            observacoes: '',

            carregando: false,
            mensagemErro: '',

            perfil: localStorage.getItem('perfil') || 'estudio',
            regraJson: localStorage.getItem('regra') || null,
            userId: localStorage.getItem('user_id') || null,
            nomeUsuario: localStorage.getItem('nome_usuario') || '',
            nomeArquivoConfig: localStorage.getItem('regra') ? 'Configurado' : 'Nenhum arquivo selecionado'
        });

        function mostrarLoading(mostrar) {
            const overlay = document.getElementById('loadingOverlay');
            if (overlay) {
                if (mostrar) {
                    overlay.classList.remove('d-none');
                } else {
                    overlay.classList.add('d-none');
                }
            }
        }

        function mostrarErro(mensagem) {
            const alertEl = document.getElementById('errorMessage');
            const textEl = document.getElementById('errorText');
            if (alertEl && textEl) {
                if (mensagem) {
                    textEl.textContent = mensagem;
                    alertEl.classList.remove('d-none');
                } else {
                    alertEl.classList.add('d-none');
                }
            }
        }

        function mostrarMensagem(texto) {
            const alertEl = document.getElementById('errorMessage');
            const textEl = document.getElementById('errorText');
            if (alertEl && textEl) {
                textEl.textContent = texto;
                alertEl.className = 'alert alert-info';
                alertEl.classList.remove('d-none');
                setTimeout(function() {
                    alertEl.classList.add('d-none');
                }, 3000);
            }
        }

        // Quanto tempo aguentar sem plataforma antes de avisar na tela. Tem que ser maior que
        // o intervalo de reconexao (3s) pra cobrir a queda por ociosidade do Jetty sem piscar,
        // e curto o bastante pra queda de verdade aparecer rapido.
        const TOLERANCIA_RECONEXAO_MS = 9000;

        function conectarWebSocket() {
            // A ponte com start.jar sempre escuta na porta 8099 (nunca na porta
            // do server.js) - nao usar window.location.host aqui, senao acessando
            // via http://localhost:3000 a porta fica errada e o WebSocket nunca conecta.
            const host = window.location.hostname || 'localhost';
            const url = `ws://${host}:8099/events/`;

            try {
                estado.websocket = new WebSocket(url);

                estado.websocket.onopen = function () {
                    estado.reconectandoDesde = null;
                    estado.conectado = true;
                    atualizarStatusConexao();
                    console.log('WebSocket conectado:', url);
                    iniciarMonitoramentoTemp();
                };

                estado.websocket.onclose = function (event) {
                    pararMonitoramentoTemp();
                    console.log('WebSocket desconectado. Code:', event.code, 'Reason:', event.reason);

                    // O Jetty do start.jar derruba o socket OCIOSO a cada 5 min
                    // ("Idle timeout expired: 300000 ms", close code 1001) - e a reconexao
                    // logo abaixo devolve em ~3s. Por isso NAO marcamos desconectado de cara:
                    // senao a tela piscava o overlay de "sem plataforma" a cada 5 minutos,
                    // sozinha, com o fotografo sem ter feito nada - e ele achava que caiu.
                    // So avisa de verdade se a reconexao nao voltar dentro da tolerancia.
                    if (!estado.reconectandoDesde) estado.reconectandoDesde = Date.now();
                    if (Date.now() - estado.reconectandoDesde > TOLERANCIA_RECONEXAO_MS) {
                        estado.conectado = false;
                        atualizarStatusConexao();
                    }

                    setTimeout(conectarWebSocket, 3000);
                };

                estado.websocket.onerror = function (e) {
                    console.error('Erro WebSocket:', e);
                    estado.conectado = false;
                    atualizarStatusConexao();
                };

                estado.websocket.onmessage = function (event) {
                    console.log('WS message:', event.data.substring(0, 200));
                    processarMensagem(event.data);
                };
            } catch (e) {
                console.error('Erro ao conectar WebSocket:', e);
                setTimeout(conectarWebSocket, 3000);
            }
        }

        function atualizarStatusConexao() {
            const icone = document.getElementById('iconeConexao');
            const texto = document.getElementById('statusTexto');
            if (icone) {
                icone.className = estado.conectado ? 'bi bi-cloud-check' : 'bi bi-cloud-slash';
            }
            if (texto) {
                texto.textContent = estado.conectado ? 'Conectado' : 'Desconectado';
            }
            atualizarOverlayDesconexao();
        }

        function atualizarStatusCamera(conectada) {
            estado.cameraConectada = conectada;
            const icone = document.getElementById('iconeCamera');
            const texto = document.getElementById('statusCameraTexto');
            if (icone) {
                icone.classList.toggle('camera-desligada', estado.cameraDesligada);
                icone.classList.toggle('camera-ok', !estado.cameraDesligada && conectada);
                icone.classList.toggle('camera-off', !estado.cameraDesligada && !conectada);
            }
            if (texto) {
                texto.textContent = estado.cameraDesligada
                    ? 'Câmera desligada'
                    : (conectada ? 'Câmera conectada' : 'Câmera desconectada');
            }
            atualizarOverlayDesconexao();
        }

        function alternarCameraDesligada(desligada) {
            estado.cameraDesligada = desligada;
            localStorage.setItem('cameraDesligada', desligada ? '1' : '0');
            const checkCameraOff = document.getElementById('checkCameraOff');
            if (checkCameraOff) checkCameraOff.checked = desligada;
            atualizarStatusCamera(estado.cameraConectada);
        }

        function verificarStatusCamera() {
            fetch('http://localhost:3000/api/status/camera')
                .then(function(resp) { return resp.json(); })
                .then(function(dados) {
                    atualizarStatusCamera(!!dados.conectada);
                })
                .catch(function() {
                    atualizarStatusCamera(false);
                });
        }

        // Mostra um overlay bloqueando a tela sempre que a camera e/ou a plataforma
        // (websocket com o start.jar) estiverem desconectadas, com botao pra reconectar.
        function atualizarOverlayDesconexao() {
            const overlay = document.getElementById('overlayDesconexao');
            const titulo = document.getElementById('overlayDesconexaoTitulo');
            const btnCamera = document.getElementById('btnReconectarCamera');
            const btnCameraOff = document.getElementById('btnCameraOffOverlay');
            const btnSistema = document.getElementById('btnReconectarSistema');
            if (!overlay) return;

            const cameraOk = estado.cameraDesligada || estado.cameraConectada;
            const sistemaOk = estado.conectado;

            if (cameraOk && sistemaOk) {
                overlay.classList.add('d-none');
                return;
            }

            overlay.classList.remove('d-none');
            if (btnCamera) btnCamera.classList.toggle('d-none', cameraOk);
            if (btnCameraOff) btnCameraOff.classList.toggle('d-none', cameraOk);
            if (btnSistema) btnSistema.classList.toggle('d-none', sistemaOk);

            if (!sistemaOk && !cameraOk) {
                titulo.textContent = 'Câmera e sistema desconectados';
            } else if (!sistemaOk) {
                titulo.textContent = 'Sistema desconectado';
            } else {
                titulo.textContent = 'Câmera desconectada';
            }
        }

        // fetch() resolve mesmo em 404/500 (ex.: server.js antigo sem o endpoint) -
        // sem este check o clique falha em silencio e o usuario nao ve nada acontecer.
        function exigirRespostaOk(resp) {
            if (!resp.ok) {
                throw new Error('servidor local respondeu ' + resp.status +
                    ' - server.js desatualizado ou errado na porta 3000');
            }
            return resp;
        }

        function reconectarCamera() {
            mostrarMensagem('Reiniciando câmera...');
            fetch('http://localhost:3000/api/iniciar/camera', { method: 'POST' })
                .then(function(resp) {
                    if (!resp.ok) {
                        return resp.json().catch(function() { return {}; }).then(function(erro) {
                            throw new Error(erro.error || ('servidor local respondeu ' + resp.status));
                        });
                    }
                    return resp;
                })
                .catch(function(err) {
                    console.error('Erro ao reiniciar camera:', err);
                    mostrarErro('Erro ao reiniciar câmera: ' + err.message);
                });
        }

        function reconectarSistema() {
            mostrarMensagem('Reiniciando sistema...');
            fetch('http://localhost:3000/api/iniciar/plataforma', { method: 'POST' })
                .then(function(resp) {
                    if (!resp.ok) {
                        // Diferente do exigirRespostaOk generico - aqui o server.js manda um
                        // motivo especifico (ex.: "Java não encontrado"), vale a pena mostrar
                        // em vez do "servidor respondeu 500" generico.
                        return resp.json().catch(function() { return {}; }).then(function(erro) {
                            throw new Error(erro.error || ('servidor local respondeu ' + resp.status));
                        });
                    }
                    return resp;
                })
                .then(function() {
                    setTimeout(conectarWebSocket, 2000);
                })
                .catch(function(err) {
                    console.error('Erro ao reiniciar plataforma:', err);
                    mostrarErro('Erro ao reiniciar sistema: ' + err.message);
                });
        }

        // Consulta o Redmine (via server.js) pra cada GTIN parado em OS_NONE e move
        // pra pasta da OS real quando ela ja existir. Roda no server.js, independente
        // desta aba estar aberta - so precisa do start.jar rodando.
        function escanearOsNone() {
            const btn = document.getElementById('btnScanOsNone');
            const resultadoEl = document.getElementById('resultadoScanOsNone');
            if (btn) btn.disabled = true;
            if (resultadoEl) resultadoEl.innerHTML = '<span class="text-muted">Consultando o Redmine...</span>';

            fetch('http://localhost:3000/api/scan-os-none', { method: 'POST' })
                .then(function(resp) { return resp.json(); })
                .then(function(dados) {
                    if (!dados.ok) throw new Error(dados.error || 'Falha no escaner');
                    renderizarResultadoScanOsNone(dados.resultado);
                })
                .catch(function(err) {
                    console.error('Erro ao escanear OS_NONE:', err);
                    if (resultadoEl) resultadoEl.innerHTML = '<span class="text-danger">Erro: ' + err.message + '</span>';
                })
                .finally(function() {
                    if (btn) btn.disabled = false;
                });
        }

        function renderizarResultadoScanOsNone(resultado) {
            const resultadoEl = document.getElementById('resultadoScanOsNone');
            if (!resultadoEl) return;

            if (!resultado || resultado.length === 0) {
                resultadoEl.innerHTML = '<span class="text-muted">Nenhum GTIN em OS_NONE no momento.</span>';
                return;
            }

            const linhas = resultado.map(function(item) {
                if (item.status === 'movido') {
                    return '<div class="text-success">' + item.gtin + ' → movido pra OS_' + item.os + ' (' + item.arquivos + ' arquivos)</div>';
                }
                if (item.status === 'erro') {
                    return '<div class="text-danger">' + item.gtin + ' → erro: ' + item.erro + '</div>';
                }
                return '<div class="text-muted">' + item.gtin + ' → ainda sem OS</div>';
            });
            resultadoEl.innerHTML = linhas.join('');
        }

        function enviarComando(comando) {
            if (estado.websocket && estado.websocket.readyState === WebSocket.OPEN) {
                estado.websocket.send(comando);
            } else {
                console.warn('WebSocket não conectado');
                mostrarErro('WebSocket não conectado. Verifique a conexão com o servidor.');
            }
        }

        function processarMensagem(mensagem) {
            try {
                if (mensagem.includes('OK_LIMPAR_PASTATEMP')) {
                    const inputGtin = document.getElementById('inputGtin');
                    if (inputGtin) inputGtin.value = '';
                    estado.imagensAtual = [];
                    renderizarMiniaturas();
                    mostrarMensagem('Pasta temporária limpa!');
                    return;
                }

                if (mensagem.includes('ERRO_LIMPAR_PASTATEMP')) {
                    mostrarErro('Erro ao limpar pasta temporária');
                    return;
                }

                if (mensagem.includes('ERRO_RET_GETGTIN')) {
                    mostrarErro('Erro ao buscar GTIN!');
                    return;
                }

                if (mensagem.includes('RET_PLATAFORMA')) {
                    processarRetPlataforma(mensagem);
                    return;
                }

                console.log('Mensagem desconhecida:', mensagem);
            } catch (e) {
                console.error('Erro ao processar mensagem:', e);
            }
        }

        function processarRetPlataforma(mensagem) {
            try {
                var str = mensagem.substring(14);
                var obj = JSON.parse(str);

                if (estado.origem === 'GET_GTIN') {
                    if (obj.demandas && obj.demandas.length > 0) {
                        var demanda = obj.demandas[0];
                        estado.demandaId = demanda.id;
                        estado.gtinAtual = demanda.gtin;
                        estado.osAtual = demanda.os;
                        estado.descricaoProduto = (demanda.subject || '').replace(demanda.gtin + ' - ', '');

                        document.getElementById('inputGtin').value = demanda.gtin;
                        document.getElementById('inputOs').value = demanda.os;

                        if (demanda.atualizacao === '1') {
                            document.getElementById('isUpdateLabel').textContent = 'Atualização';
                        } else {
                            document.getElementById('isUpdateLabel').textContent = 'Cadastro Novo';
                        }
                        document.getElementById('isUpdateLabel').classList.remove('d-none');

                        var situacao = (demanda.situacaoImagem || demanda['Situação das Imagens'] || '').trim();
                        if (situacao) {
                            var labelSituacao = document.getElementById('isUpdateLabel');
                            labelSituacao.textContent = situacao;
                            var sLower = situacao.toLowerCase();
                            if (sLower === 'retrabalho') {
                                labelSituacao.style.backgroundColor = '#1a1a1a';
                                labelSituacao.style.border = '1px solid #555';
                            } else if (sLower === 'aguardando fotografia') {
                                labelSituacao.style.backgroundColor = '#dc3545';
                                labelSituacao.style.border = '';
                            } else {
                                // qualquer status pos-fotografia = verde (finalizado pro fotografo)
                                labelSituacao.style.backgroundColor = '#28a745';
                                labelSituacao.style.border = '';
                            }
                        }

                        // Agora buscar a OS para listar todos os GTINs
                        request('OS', demanda.os, 'GET_OS', 'GET');
                    } else {
                        // GTIN ainda sem OS no Redmine (produto fotografado antes da OS
                        // ser criada) - trata como OS_NONE, fotografa e salva normalmente
                        // dentro da pasta do GTIN, so que sob OS_NONE em vez da OS real.
                        estado.osAtual = 'NONE';
                        estado.listaGtins = [];
                        estado.gtinAtivoIndex = -1;
                        estado.descricaoProduto = 'Produto sem OS no Redmine (OS_NONE)';
                        document.getElementById('inputOs').value = 'NONE';
                        document.getElementById('inputQtdeGtin').value = 0;
                        document.getElementById('isUpdateLabel').classList.add('d-none');
                        mostrarMensagem('GTIN sem OS no Redmine - fotografando em OS_NONE');

                        buscarImagensTemp();
                        buscarImagensOS();
                    }

                } else if (estado.origem === 'GET_OS') {
                    // Lista de GTINs da OS
                    if (obj.demandas) {
                        estado.listaGtins = obj.demandas.map(function(d) {
                            var situacao = (d.situacaoImagem || d['Situação das Imagens'] || '').trim().toLowerCase();
                            var status;
                            if (situacao === 'retrabalho') {
                                status = 'retrabalho';
                            } else if (situacao === 'aguardando fotografia' || situacao === '') {
                                status = 'aberto';
                            } else {
                                // Qualquer status alem de "aguardando fotografia" ja passou da
                                // etapa do fotografo (Aguardando QA Fotografia, Ag. Conferencia,
                                // Em Conferencia, Aguardando Edicao, etc.) -> pro fotografo esta
                                // finalizado. Antes, esses caiam em 'aberto' e o GTIN "reabria"
                                // na lista depois da entrega.
                                status = 'finalizado';
                            }
                            return {
                                gtin: d.gtin,
                                descricao: (d.subject || '').replace(d.gtin + ' - ', ''),
                                status: status,
                                id: d.id
                            };
                        });
                        estado.qtdeGtins = obj.demandas.length;

                        document.getElementById('inputQtdeGtin').value = obj.demandas.length;

                        var idxAtivo = estado.listaGtins.findIndex(function(g) {
                            return g.gtin === estado.gtinAtual;
                        });
                        estado.gtinAtivoIndex = idxAtivo;
                    }

                    // Buscar imagens do palco Atual (temp) e do palco Anterior (pasta OS/GTIN)
                    buscarImagensTemp();
                    buscarImagensOS();

                } else if (estado.origem === 'ACAO') {
                    mostrarMensagem('Imagens finalizadas com sucesso!');
                    estado.gtinAtual = 'NONE';
                    estado.osAtual = 'NONE';
                    estado.listaGtins = [];
                    estado.imagensAnterior = [];
                    // Sem isso o rotulo fica preso mostrando a situacao de ANTES de
                    // finalizar (ex.: "Aguardando Fotografia"), ja que so e atualizado
                    // numa nova busca de GTIN (GET_GTIN), nao na resposta do ACAO.
                    document.getElementById('isUpdateLabel').classList.add('d-none');
                    renderizarMiniaturas();
                    renderizarListaGtins();
                }

                estado.carregando = false;
                mostrarLoading(false);
                atualizarDOM();
            } catch (err) {
                console.error('Erro ao processar RET_PLATAFORMA:', err);
                mostrarErro('Produto não encontrado');
                estado.carregando = false;
                mostrarLoading(false);
            }
        }

        function montarObjRequest(campo, valor, porigem, identificador, demandas) {
            if (!estado.regraJson) {
                mostrarErro('Regra não configurada!');
                return null;
            }

            var jsonEnvio = estado.regraJson.replaceAll('#CAMPO_NOME', campo);
            jsonEnvio = jsonEnvio.replaceAll('#CAMPO_VALOR', valor);
            var objRegra = JSON.parse(jsonEnvio);

            var objRequest = {};
            objRequest.identificador = identificador;
            objRequest.rule = objRegra;

            objRequest.camposEspecificos = [];
            var campoOs = { nome: 'OS', alias: 'os' };
            var campoAtualizacao = { nome: 'Atualização', alias: 'atualizacao' };
            var campoFotografo = { nome: 'Fotógrafo', alias: 'fotografo' };
            var campoGtin = { nome: 'GTIN', alias: 'gtin' };
            var campoSituacao = { nome: 'Situação das Imagens', alias: 'situacaoImagem' };
            objRequest.camposEspecificos.push(campoOs, campoAtualizacao, campoFotografo, campoGtin, campoSituacao);

            objRequest.demandas = demandas;

            return objRequest;
        }

        function request(campo, valor, porigem, identificador, demandas) {
            var objRequest = montarObjRequest(campo, valor, porigem, identificador, demandas);
            if (!objRequest) return;

            estado.origem = porigem;
            var str = JSON.stringify(objRequest);
            enviarComando('PLATAFORMA_' + str);
        }

        function mapearImagens(lista) {
            return (lista || []).map(function(img) {
                return {
                    nome: img.nome || img.arquivo,
                    arquivo: img.arquivo,
                    urlMiniatura: 'data:image/jpeg;base64,' + img.arquivo,
                    urlCompleta: null
                };
            });
        }

        // ETags da ultima resposta - evita reler/rebase64 e retransmitir todas as fotos
        // (algumas com varios MB) a cada poll de 3s quando a pasta nao mudou.
        var ultimoEtagTemp = null;
        var ultimoEtagAnterior = null;

        function buscarImagensTemp() {
            var query = new URLSearchParams({ gtin: estado.gtinAtual || 'NONE' });
            var headers = ultimoEtagTemp ? { 'If-None-Match': ultimoEtagTemp } : {};
            fetch('http://localhost:3000/api/imagens/temp?' + query.toString(), { headers: headers })
                .then(function(resp) {
                    ultimoEtagTemp = resp.headers.get('ETag') || ultimoEtagTemp;
                    if (resp.status === 304) return null;
                    return resp.json();
                })
                .then(function(dados) {
                    if (!dados) return;
                    estado.imagensAtual = mapearImagens(dados.imagens);
                    var nomesAtuais = {};
                    estado.imagensAtual.forEach(function(img) { nomesAtuais[img.nome] = true; });
                    estado.imagensMarcadas = estado.imagensMarcadas.filter(function(nome) {
                        return nomesAtuais[nome];
                    });
                    renderizarMiniaturas();
                })
                .catch(function(err) {
                    console.error('Erro ao buscar imagens temp (server.js rodando?):', err);
                });
        }

        var intervaloMonitorTemp = null;

        function iniciarMonitoramentoTemp() {
            if (intervaloMonitorTemp) return;
            buscarImagensTemp();
            verificarStatusCamera();
            intervaloMonitorTemp = setInterval(function() {
                buscarImagensTemp();
                verificarStatusCamera();
                if (estado.imagensAnterior.length === 0) {
                    buscarImagensOS();
                }
            }, 3000);
        }

        function pararMonitoramentoTemp() {
            if (intervaloMonitorTemp) {
                clearInterval(intervaloMonitorTemp);
                intervaloMonitorTemp = null;
            }
        }

        function buscarImagensOS() {
            // gtinAtual 'NONE' = nenhuma busca feita ainda. osAtual 'NONE' e valido
            // (GTIN sem OS no Redmine ainda) - trata a pasta OS_NONE normalmente.
            if (!estado.gtinAtual || estado.gtinAtual === 'NONE') return;

            buscarSubpastasAnterior();

            var query = new URLSearchParams({
                os: estado.osAtual,
                gtin: estado.gtinAtual
            });

            var headers = ultimoEtagAnterior ? { 'If-None-Match': ultimoEtagAnterior } : {};
            fetch('http://localhost:3000/api/imagens/anterior?' + query.toString(), { headers: headers })
                .then(function(resp) {
                    ultimoEtagAnterior = resp.headers.get('ETag') || ultimoEtagAnterior;
                    if (resp.status === 304) return null;
                    return resp.json();
                })
                .then(function(dados) {
                    if (!dados) return;
                    var imagensMapeadas = mapearImagens(dados.imagens);
                    estado.imagensAnterior = imagensMapeadas;
                    var nomesAnteriores = {};
                    imagensMapeadas.forEach(function(img) { nomesAnteriores[img.nome] = true; });
                    estado.imagensMarcadasAnterior = estado.imagensMarcadasAnterior.filter(function(nome) {
                        return nomesAnteriores[nome];
                    });
                    if (imagensMapeadas.length > 0 && estado.gtinAtivoIndex >= 0) {
                        var gtinAtivo = estado.listaGtins[estado.gtinAtivoIndex];
                        if (gtinAtivo && gtinAtivo.status === 'aberto') {
                            gtinAtivo.status = 'salvo';
                            renderizarListaGtins();
                        }
                    }
                    renderizarMiniaturas();
                })
                .catch(function(err) {
                    console.error('Erro ao buscar imagens anterior (server.js rodando?):', err);
                });
        }

        function salvarLocalmente(obs) {
            var checkOcr = document.getElementById('checkOcr');
            var body = {
                os: estado.osAtual,
                gtin: estado.gtinAtual,
                perfil: estado.perfil,
                obs: obs || '',
                // Checkbox OCR do topo = o trabalho e SO OCR: o servidor converte o CR2 em JPG
                // na estrutura OCR e dispensa o RAW (nao alimenta Finalizadas\OS_x\gtin).
                modoOcr: !!(checkOcr && checkOcr.checked)
            };

            return fetch('http://localhost:3000/api/salvar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(function(resp) {
                if (!resp.ok) {
                    return resp.json().catch(function() { return {}; }).then(function(erro) {
                        throw new Error(erro.error || ('HTTP ' + resp.status));
                    });
                }
                return resp.json();
            }).then(function(resposta) {
                buscarImagensTemp();
                buscarImagensOS();
                if (body.modoOcr) {
                    var qtd = (resposta && resposta.movidos) || 0;
                    var cad = resposta && resposta.cadastro;
                    if (cad && cad.falharam > 0) {
                        mostrarErro('OCR: ' + qtd + ' foto(s) geradas. ' + textoCadastro(cad));
                    } else {
                        mostrarMensagem('OCR: ' + qtd + ' foto(s) geradas (RAW dispensado). ' + textoCadastro(cad));
                    }
                }
            });
        }

        // Traduz o resultado da copia pro Cadastro (pasta de rede) numa frase pra tela. Existe
        // porque a copia e best-effort: se a rede cair, o OCR local sai do mesmo jeito - mas o
        // fotografo TEM que saber que nao foi pro Cadastro, senao acha que entregou e nao entregou.
        function textoCadastro(cadastro) {
            if (!cadastro || !cadastro.ligado) return 'Só local (cópia pro Cadastro desligada).';
            if (cadastro.falharam > 0) {
                return '⚠ NÃO foi pro Cadastro (' + (cadastro.motivo || 'rede fora') +
                    ') - o OCR está salvo aqui, dá pra reenviar depois.';
            }
            if (cadastro.copiados > 0) return 'Enviadas pro Cadastro.';
            return '';
        }

        // Botao OCR do palco Anterior: gera o JPG de OCR SO das fotos marcadas, a partir do
        // preview embutido no CR2 que ja esta no Finalizadas. Usado quando o trabalho e edicao
        // E OCR - o RAW continua onde esta, so ganha uma copia JPG na estrutura OCR.
        // (Quando o trabalho e SO OCR, o caminho e o checkbox do topo, que dispensa o RAW.)
        function gerarOcrDasMarcadas() {
            if (estado.imagensMarcadasAnterior.length === 0) {
                mostrarErro('Marque as imagens do palco Anterior que vão para OCR');
                return Promise.resolve();
            }

            return fetch('http://localhost:3000/api/ocr/gerar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    os: estado.osAtual,
                    gtin: estado.gtinAtual,
                    arquivos: estado.imagensMarcadasAnterior
                })
            }).then(function(resp) {
                return resp.json().catch(function() { return {}; });
            }).then(function(r) {
                var problema = r && (r.erro || r.error);
                if (problema) {
                    mostrarErro('OCR não foi gerado: ' + problema);
                    return;
                }
                var gerados = (r && r.gerados) || [];
                var falhas = (r && r.falhas) || [];
                if (falhas.length > 0) {
                    mostrarErro('OCR: ' + gerados.length + ' gerada(s), ' + falhas.length + ' falharam');
                } else {
                    mostrarMensagem('OCR: ' + gerados.length + ' foto(s). ' + textoCadastro(r && r.cadastro));
                }
                estado.imagensMarcadasAnterior = [];
                buscarImagensOS();
            }).catch(function(err) {
                mostrarErro('OCR não foi gerado: ' + err.message);
            });
        }

        function buscarGTIN() {
            if (!estado.conectado) {
                mostrarErro('Conexão não está ativa!');
                return;
            }
            if (!estado.regraJson) {
                mostrarErro('Regra não configurada! Clique no ícone de engrenagem.');
                return;
            }
            if (!estado.userId) {
                mostrarErro('Usuário não configurado! Clique no ícone de engrenagem.');
                return;
            }

            const input = document.getElementById('inputGtin');
            const gtin = input ? input.value.trim() : '';
            if (!gtin) {
                mostrarErro('Digite um GTIN para buscar');
                return;
            }

            estado.gtinAtual = gtin;
            estado.gtinAtivoIndex = -1;
            estado.imagensAnterior = [];
            ultimoEtagAnterior = null;
            renderizarMiniaturas();
            estado.carregando = true;
            mostrarLoading(true);
            mostrarErro('');
            document.getElementById('isUpdateLabel').classList.add('d-none');

            request('GTIN', gtin, 'GET_GTIN', 'GET');
        }

        function salvar() {
            if (!estado.gtinAtual) {
                mostrarErro('Nenhum GTIN selecionado');
                return;
            }
            estado.carregando = true;
            mostrarLoading(true);
            mostrarErro('');

            estado.observacoes = document.getElementById('inputObs')?.value || '';

            salvarLocalmente(estado.observacoes).then(function() {
                atualizarStatusGtin('salvo');
                mostrarMensagem('Imagens salvas!');
            }).catch(function(err) {
                console.error('Erro ao salvar imagens (server.js rodando?):', err);
                mostrarErro('Erro ao salvar imagens: ' + err.message);
            }).finally(function() {
                estado.carregando = false;
                mostrarLoading(false);
            });
        }

        function finalizar() {
            if (!estado.gtinAtual) {
                mostrarErro('Nenhum GTIN selecionado');
                return;
            }

            estado.observacoes = document.getElementById('inputObs')?.value || estado.observacoes;

            // Garante que as imagens estejam organizadas mesmo se o usuário não clicou Salvar antes.
            salvarLocalmente(estado.observacoes).then(function() {
                // OS_NONE = GTIN ainda sem OS no Redmine - nao ha demanda pra finalizar
                // la, so organiza os arquivos localmente em OS_NONE.
                if (estado.osAtual === 'NONE') {
                    mostrarMensagem('Imagens organizadas em OS_NONE! Refaça a busca quando a OS for criada no Redmine.');
                    return;
                }
                var demandas = [];
                demandas.push(estado.demandaId);
                request('GTIN', estado.gtinAtual, 'ACAO', 'ACAO', demandas);
                atualizarStatusGtin('finalizado');
            }).catch(function(err) {
                console.error('Erro ao salvar imagens (server.js rodando?):', err);
                mostrarErro('Erro ao salvar imagens: ' + err.message);
            });
        }

        function limparTemp() {
            enviarComando('LIMPAR_TEMP');
        }

        function deletarImagem(nomeArquivo, tipo) {
            if (!nomeArquivo) return;

            var body = { nome: nomeArquivo, tipo: tipo === 'anterior' ? 'os' : 'temp' };
            if (body.tipo === 'os') {
                body.os = estado.osAtual;
                body.gtin = estado.gtinAtual;
            }

            fetch('http://localhost:3000/api/imagem', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(function(resp) {
                if (!resp.ok) {
                    return resp.json().catch(function() { return {}; }).then(function(erro) {
                        throw new Error(erro.error || ('HTTP ' + resp.status));
                    });
                }
                return resp.json();
            }).then(function() {
                if (body.tipo === 'os') {
                    estado.imagensAnterior = estado.imagensAnterior.filter(function(img) {
                        return img.nome !== nomeArquivo;
                    });
                } else {
                    estado.imagensAtual = estado.imagensAtual.filter(function(img) {
                        return img.nome !== nomeArquivo;
                    });
                }
                if (estado.imagemSelecionada && estado.imagemSelecionada.nome === nomeArquivo) {
                    fecharModal();
                }
                renderizarMiniaturas();
                mostrarMensagem('Imagem excluída');
            }).catch(function(err) {
                console.error('Erro ao deletar imagem:', err);
                mostrarErro('Erro ao deletar imagem: ' + err.message);
            });
        }

        window.deletarImagem = deletarImagem;

        // Faz a chamada de marcar/desmarcar sufixo para um conjunto de arquivos de uma pasta especifica.
        function chamarMarcar(arquivos, sufixo, tipo) {
            var body = { arquivos: arquivos, sufixo: sufixo, tipo: tipo };
            if (tipo === 'os') {
                body.os = estado.osAtual;
                body.gtin = estado.gtinAtual;
            }

            return fetch('http://localhost:3000/api/marcar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(function(resp) {
                if (!resp.ok) {
                    return resp.json().catch(function() { return {}; }).then(function(erro) {
                        throw new Error(erro.error || ('HTTP ' + resp.status));
                    });
                }
                return resp.json();
            });
        }

        // Aplica (toggle) um sufixo (ex.: "_coding") no nome das imagens marcadas,
        // tanto no palco Atual (pasta temp) quanto no palco Anterior (pasta da OS/GTIN).
        // Generico - qualquer checkbox futuro pode chamar isso com outro sufixo.
        // Retorna a Promise para quem chamar poder esperar a conclusão (ex: o checkbox
        // só volta a desmarcado depois que o servidor confirmar a renomeação).
        function aplicarSufixoMarcadas(sufixo) {
            if (estado.imagensMarcadas.length === 0 && estado.imagensMarcadasAnterior.length === 0) {
                mostrarErro('Marque ao menos uma imagem antes');
                return Promise.resolve();
            }

            var chamadas = [];
            if (estado.imagensMarcadas.length > 0) {
                chamadas.push(chamarMarcar(estado.imagensMarcadas, sufixo, 'temp'));
            }
            if (estado.imagensMarcadasAnterior.length > 0) {
                chamadas.push(chamarMarcar(estado.imagensMarcadasAnterior, sufixo, 'os'));
            }

            return Promise.all(chamadas).then(function() {
                estado.imagensMarcadas = [];
                estado.imagensMarcadasAnterior = [];
                buscarImagensTemp();
                buscarImagensOS();
                mostrarMensagem('Imagens atualizadas com ' + sufixo + '!');
            }).catch(function(err) {
                console.error('Erro ao marcar imagens:', err);
                mostrarErro('Erro ao marcar imagens: ' + err.message);
            });
        }

        // RT/IS/AP - no palco Anterior (ja salvo) move de fato a imagem pra subpasta.
        // No palco Atual (temp, ainda na captura) so marca um sufixo (_RT/_IS/_AP) no
        // nome, igual o _coding faz - o arquivo continua solto na raiz de images/temp.
        // salvarImagens() (server.js) le esse sufixo na hora de salvar e cria a
        // subpasta certa dentro de Finalizadas, retirando o sufixo do nome final.
        function aplicarSubpasta(pasta) {
            if (estado.imagensMarcadas.length === 0 && estado.imagensMarcadasAnterior.length === 0) {
                mostrarErro('Marque ao menos uma imagem antes');
                return Promise.resolve();
            }

            var chamadas = [];
            if (estado.imagensMarcadas.length > 0) {
                chamadas.push(chamarMarcar(estado.imagensMarcadas, '_' + pasta, 'temp'));
            }
            if (estado.imagensMarcadasAnterior.length > 0) {
                chamadas.push(fetch('http://localhost:3000/api/tag-subpasta', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        os: estado.osAtual,
                        gtin: estado.gtinAtual,
                        arquivos: estado.imagensMarcadasAnterior,
                        pasta: pasta
                    })
                }).then(function(resp) {
                    if (!resp.ok) {
                        return resp.json().catch(function() { return {}; }).then(function(erro) {
                            throw new Error(erro.error || ('HTTP ' + resp.status));
                        });
                    }
                    return resp.json();
                }));
            }

            return Promise.all(chamadas).then(function() {
                estado.imagensMarcadas = [];
                estado.imagensMarcadasAnterior = [];
                buscarImagensTemp();
                buscarImagensOS();
                mostrarMensagem('Imagens marcadas para ' + pasta + '!');
            }).catch(function(err) {
                console.error('Erro ao mover para ' + pasta + ':', err);
                mostrarErro('Erro ao mover para ' + pasta + ': ' + err.message);
            });
        }

        // Miniaturas das subpastas RT/IS/AP (ja fisicamente movidas, palco Anterior) -
        // senao a foto so some da tela quando marcada, sem chance de conferir/desfazer.
        function buscarSubpastasAnterior() {
            var query = new URLSearchParams({ os: estado.osAtual, gtin: estado.gtinAtual });
            fetch('http://localhost:3000/api/imagens/subpastas?' + query.toString())
                .then(function(resp) { return resp.json(); })
                .then(function(dados) {
                    if (!dados.ok) return;
                    estado.subpastasAnterior = dados.subpastas || {};
                    renderizarSubpastasAnterior();
                })
                .catch(function(err) {
                    console.error('Erro ao buscar subpastas RT/IS/AP:', err);
                });
        }

        function renderizarSubpastasAnterior() {
            var container = document.getElementById('subpastasAnterior');
            if (!container) return;
            container.innerHTML = '';

            ['RT', 'IS', 'AP'].forEach(function(tag) {
                var lista = estado.subpastasAnterior[tag];
                if (!lista || lista.length === 0) return;

                var titulo = document.createElement('div');
                titulo.className = 'subpasta-preview-titulo';
                titulo.textContent = tag + ' (' + lista.length + ')';
                container.appendChild(titulo);

                var grid = document.createElement('div');
                grid.className = 'subpasta-preview-grid';
                lista.forEach(function(img) {
                    var item = document.createElement('div');
                    item.className = 'subpasta-preview-item ' + tag.toLowerCase();
                    item.innerHTML = '<img src="data:image/jpeg;base64,' + img.arquivo + '" title="' + img.nome + '">' +
                        '<button type="button" class="btn-voltar">Voltar</button>';
                    item.querySelector('.btn-voltar').addEventListener('click', function() {
                        voltarDeSubpasta(img.nome, tag);
                    });
                    grid.appendChild(item);
                });
                container.appendChild(grid);
            });
        }

        function voltarDeSubpasta(nome, tag) {
            fetch('http://localhost:3000/api/tag-subpasta', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ os: estado.osAtual, gtin: estado.gtinAtual, arquivos: [nome], pasta: tag })
            }).then(function(resp) {
                if (!resp.ok) {
                    return resp.json().catch(function() { return {}; }).then(function(erro) {
                        throw new Error(erro.error || ('HTTP ' + resp.status));
                    });
                }
                return resp.json();
            }).then(function() {
                buscarImagensOS();
                mostrarMensagem('Imagem devolvida para a raiz');
            }).catch(function(err) {
                mostrarErro('Erro ao devolver imagem: ' + err.message);
            });
        }

        function renderizarMiniaturas() {
            const gridAnterior = document.getElementById('gridAnterior');
            if (gridAnterior) {
                gridAnterior.innerHTML = '';
                if (estado.imagensAnterior && estado.imagensAnterior.length > 0) {
                    estado.imagensAnterior.forEach(function(imagem, index) {
                        gridAnterior.appendChild(criarMiniatura(imagem, 'anterior', index));
                    });
                } else {
                    gridAnterior.innerHTML = '<div class="col-12 grid-empty">Nenhuma imagem anterior</div>';
                }
            }

            const gridAtual = document.getElementById('gridAtual');
            if (gridAtual) {
                gridAtual.innerHTML = '';
                if (estado.imagensAtual && estado.imagensAtual.length > 0) {
                    estado.imagensAtual.forEach(function(imagem, index) {
                        gridAtual.appendChild(criarMiniatura(imagem, 'atual', index));
                    });
                } else {
                    gridAtual.innerHTML = '<div class="col-12 grid-empty">Nenhuma imagem nesta sessão</div>';
                }
            }
        }

        function criarMiniatura(imagem, tipo, index) {
            const col = document.createElement('div');
            col.className = 'col-md-3 col-sm-4 col-6 mb-3';

            const div = document.createElement('div');
            div.className = 'miniatura';
            var marcadas = tipo === 'anterior' ? estado.imagensMarcadasAnterior : estado.imagensMarcadas;
            if (marcadas.includes(imagem.nome)) {
                div.classList.add('marcada');
            }
            if (temSufixo(imagem.nome, '_coding')) {
                div.classList.add('tem-coding');
            }
            ['RT', 'IS', 'AP'].forEach(function(tag) {
                if (temSufixo(imagem.nome, '_' + tag)) {
                    div.classList.add('tem-' + tag.toLowerCase());
                }
            });

            const imgSrc = imagem.urlMiniatura || imagem.url ||
                (imagem.arquivo ? 'data:image/jpeg;base64,' + imagem.arquivo : '');

            div.innerHTML = `
                <img src="${imgSrc}" alt="${imagem.nome || 'Imagem'}">
                <button class="btn-deletar" data-nome="${imagem.nome}">
                    <i class="bi bi-x"></i>
                </button>
                <button class="btn-marcar" title="Marcar imagem"><i class="bi bi-check-lg"></i></button>
            `;

            const btnDeletar = div.querySelector('.btn-deletar');
            if (btnDeletar) {
                btnDeletar.addEventListener('click', function(e) {
                    e.stopPropagation();
                    deletarImagem(imagem.nome, tipo);
                });
            }

            const btnMarcar = div.querySelector('.btn-marcar');
            if (btnMarcar) {
                btnMarcar.addEventListener('click', function(e) {
                    e.stopPropagation();
                    alternarMarcacao(imagem.nome, tipo);
                });
            }

            div.addEventListener('click', function(e) {
                if (e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
                    abrirModalImagem(imagem, tipo);
                }
            });

            col.appendChild(div);
            return col;
        }

        // Verifica se o nome do arquivo (sem extensao) ja termina com o sufixo dado.
        function temSufixo(nome, sufixo) {
            if (!nome) return false;
            var ext = obterExtensao(nome);
            var semExt = ext ? nome.slice(0, -ext.length) : nome;
            return semExt.endsWith(sufixo);
        }

        function obterExtensao(nome) {
            var idx = nome.lastIndexOf('.');
            return idx >= 0 ? nome.slice(idx) : '';
        }

        // Marcacao generica de imagens (palco Atual ou Anterior) - reutilizavel para qualquer
        // acao futura que precise operar sobre um conjunto de fotos selecionadas.
        function alternarMarcacao(nome, tipo) {
            var lista = tipo === 'anterior' ? estado.imagensMarcadasAnterior : estado.imagensMarcadas;
            var indice = lista.indexOf(nome);
            if (indice >= 0) {
                lista.splice(indice, 1);
            } else {
                lista.push(nome);
            }
            renderizarMiniaturas();
        }

        function abrirModalImagem(imagem, tipo) {
            estado.imagemSelecionada = imagem;
            estado.tipoSelecionado = tipo;

            const imgAmpliada = document.getElementById('imgAmpliada');
            const infoNome = document.getElementById('infoNome');
            const infoResolucao = document.getElementById('infoResolucao');
            const infoTamanho = document.getElementById('infoTamanho');
            const infoData = document.getElementById('infoData');

            const imgSrc = imagem.urlCompleta || imagem.url ||
                (imagem.arquivo ? 'data:image/jpeg;base64,' + imagem.arquivo : '');

            if (imgAmpliada) imgAmpliada.src = imgSrc;
            if (infoNome) infoNome.textContent = imagem.nome || '';
            if (infoResolucao) infoResolucao.textContent = imagem.resolucao || 'N/A';
            if (infoTamanho) infoTamanho.textContent = imagem.tamanho || 'N/A';
            if (infoData) infoData.textContent = imagem.data || 'N/A';

            const modal = new bootstrap.Modal(document.getElementById('modalImagem'));
            modal.show();
        }

        function fecharModal() {
            console.log('fecharModal chamado');
            const modalEl = document.getElementById('modalImagem');
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) {
                modal.hide();
            }
            estado.imagemSelecionada = null;
            estado.tipoSelecionado = null;
        }

        function navegarImagem(direcao) {
            if (!estado.imagemSelecionada) return;

            const todasImagens = [...estado.imagensAnterior, ...estado.imagensAtual];
            if (todasImagens.length === 0) return;

            const indiceAtual = todasImagens.findIndex(
                i => i.nome === estado.imagemSelecionada.nome
            );

            let novoIndice = indiceAtual + direcao;
            if (novoIndice < 0) novoIndice = todasImagens.length - 1;
            else if (novoIndice >= todasImagens.length) novoIndice = 0;

            estado.imagemSelecionada = todasImagens[novoIndice];
            estado.tipoSelecionado = novoIndice < estado.imagensAnterior.length ? 'anterior' : 'atual';

            const imgSrc = todasImagens[novoIndice].urlCompleta || todasImagens[novoIndice].url ||
                (todasImagens[novoIndice].arquivo ? 'data:image/jpeg;base64,' + todasImagens[novoIndice].arquivo : '');

            document.getElementById('imgAmpliada').src = imgSrc;
        }

        function baixarImagem() {
            if (!estado.imagemSelecionada) return;

            const link = document.createElement('a');
            const imgSrc = estado.imagemSelecionada.urlCompleta || estado.imagemSelecionada.url ||
                (estado.imagemSelecionada.arquivo ? 'data:image/jpeg;base64,' + estado.imagemSelecionada.arquivo : '');

            link.href = imgSrc;
            link.download = estado.imagemSelecionada.nome || 'imagem.jpg';
            link.click();
        }

        function copiarUrlImagem() {
            if (!estado.imagemSelecionada) return;

            const url = `${window.location.origin}/images/temp/${estado.imagemSelecionada.nome}`;
            navigator.clipboard.writeText(url).then(function() {
                mostrarMensagem('URL copiada para a área de transferência');
            }).catch(function(err) {
                console.error('Erro ao copiar URL:', err);
            });
        }

        function atualizarDOM() {
            const descricao = document.getElementById('descricaoProduto');
            const os = document.getElementById('inputOs');
            const qtde = document.getElementById('inputQtdeGtin');

            if (descricao) descricao.textContent = estado.descricaoProduto;
            if (os) os.value = estado.osAtual;
            if (qtde) qtde.value = estado.qtdeGtins;

            renderizarListaGtins();
        }

        function renderizarListaGtins() {
            const tbody = document.getElementById('listaGtins');
            if (!tbody) return;

            tbody.innerHTML = '';

            estado.listaGtins.forEach(function(gtin, index) {
                const tr = document.createElement('tr');

                if (index === estado.gtinAtivoIndex) {
                    tr.classList.add('table-active', 'ativo');
                }

                if (gtin.status === 'finalizado') {
                    tr.classList.add('finalizado');
                }

                const tdGtin = document.createElement('td');
                tdGtin.textContent = gtin.gtin || '';
                tr.appendChild(tdGtin);

                const tdDesc = document.createElement('td');
                tdDesc.textContent = gtin.descricao || '';
                tr.appendChild(tdDesc);

                const tdStatus = document.createElement('td');
                const statusBadge = document.createElement('span');
                statusBadge.className = 'status-badge status-' + gtin.status;
                var statusLabel = gtin.status === 'finalizado' ? 'Finalizado' : gtin.status === 'retrabalho' ? 'Retrabalho' : gtin.status === 'salvo' ? 'Salvo' : 'Aberto';
                statusBadge.textContent = statusLabel;
                tdStatus.appendChild(statusBadge);
                tr.appendChild(tdStatus);

                tr.addEventListener('click', function() {
                    selecionarGtin(index);
                });

                tbody.appendChild(tr);
            });
        }

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

        function atualizarStatusGtin(status) {
            if (estado.gtinAtivoIndex >= 0 && estado.listaGtins[estado.gtinAtivoIndex]) {
                estado.listaGtins[estado.gtinAtivoIndex].status = status;
                renderizarListaGtins();
            }
        }

        function configurarEventListeners() {
            document.getElementById('btnBuscar').addEventListener('click', buscarGTIN);
            document.getElementById('btnSalvar').addEventListener('click', salvar);
            document.getElementById('btnFinalizar').addEventListener('click', finalizar);
            document.getElementById('btnLimpar').addEventListener('click', limparTemp);

            document.getElementById('btnSalvarConfig').addEventListener('click', salvarConfig);
            document.getElementById('btnScanOsNone').addEventListener('click', escanearOsNone);

            // Destaca o checkbox OCR quando ligado - o fotografo tem que enxergar que cada
            // salvada esta despachando pro Cadastro.
            var checkOcr = document.getElementById('checkOcr');
            if (checkOcr) {
                checkOcr.addEventListener('change', function() {
                    document.getElementById('labelOcr').classList.toggle('ativo', checkOcr.checked);
                });
            }

            document.getElementById('btnReconectarCamera').addEventListener('click', reconectarCamera);
            document.getElementById('btnCameraOffOverlay').addEventListener('click', function() {
                alternarCameraDesligada(true);
            });
            document.getElementById('btnReconectarSistema').addEventListener('click', reconectarSistema);

            const checkCameraOff = document.getElementById('checkCameraOff');
            if (checkCameraOff) {
                checkCameraOff.checked = estado.cameraDesligada;
                checkCameraOff.addEventListener('change', function(e) {
                    alternarCameraDesligada(e.target.checked);
                });
            }

            document.getElementById('checkCoding').addEventListener('change', function(e) {
                if (!e.target.checked) return;
                var checkbox = e.target;
                aplicarSufixoMarcadas('_coding').then(function() {
                    checkbox.checked = false;
                });
            });

            // OCR por foto (palco Anterior): GERA o jpg na estrutura OCR das marcadas.
            // Antes isso so aplicava um sufixo "_ocr" no nome e nao gerava nada - por isso
            // parecia que "nao funcionava". Nao conflita com RT/IS/AP: a subpasta diz onde o
            // arquivo mora no Finalizadas, o OCR so produz uma copia jpg na estrutura OCR.
            document.getElementById('checkOcrFoto').addEventListener('change', function(e) {
                if (!e.target.checked) return;
                var checkbox = e.target;
                gerarOcrDasMarcadas().then(function() {
                    checkbox.checked = false;
                });
            });

            ['checkRT', 'checkIS', 'checkAP'].forEach(function(id) {
                var pasta = id.replace('check', '');
                document.getElementById(id).addEventListener('change', function(e) {
                    if (!e.target.checked) return;
                    var checkbox = e.target;
                    aplicarSubpasta(pasta).then(function() {
                        checkbox.checked = false;
                    });
                });
            });

            document.getElementById('btnAnterior').addEventListener('click', function() {
                navegarImagem(-1);
            });

            document.getElementById('btnProxima').addEventListener('click', function() {
                navegarImagem(1);
            });

            document.getElementById('btnDeletar').addEventListener('click', function() {
                if (estado.imagemSelecionada) {
                    deletarImagem(estado.imagemSelecionada.nome, estado.tipoSelecionado);
                }
            });

            document.getElementById('btnBaixar').addEventListener('click', baixarImagem);
            document.getElementById('btnCopiar').addEventListener('click', copiarUrlImagem);

            document.addEventListener('keydown', function(e) {
                if (!estado.imagemSelecionada) return;
                if (document.getElementById('modalImagem').classList.contains('show')) {
                    switch (e.key) {
                        case 'ArrowLeft': navegarImagem(-1); break;
                        case 'ArrowRight': navegarImagem(1); break;
                        case 'Escape': fecharModal(); break;
                    }
                }
            });

            document.getElementById('inputGtin').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    buscarGTIN();
                }
            });
        }

        function carregarVersao() {
            fetch('http://localhost:3000/api/versao')
                .then(function(resp) { return resp.json(); })
                .then(function(dados) {
                    var el = document.getElementById('headerVersao');
                    if (el) el.textContent = dados.versao;
                })
                .catch(function() { /* header segue sem versao, nao e critico */ });
        }

        function carregarConfigLocal() {
            var regra = localStorage.getItem('regra');
            var userId = localStorage.getItem('user_id');
            var nomeUsuario = localStorage.getItem('nome_usuario');
            var perfil = localStorage.getItem('perfil');

            if (regra) {
                estado.regraJson = regra;
                try {
                    var obj = JSON.parse(regra);
                    estado.userId = obj.userId || userId;
                    estado.nomeUsuario = obj.userName || nomeUsuario;
                } catch(e) {
                    estado.userId = userId;
                    estado.nomeUsuario = nomeUsuario;
                }
            }
            if (perfil) estado.perfil = perfil;

            var selectPerfil = document.getElementById('selectPerfil');
            var spanArquivo = document.getElementById('arquivoConfigAtual');
            var spanUsuario = document.getElementById('nomeUsuario');

            if (selectPerfil) selectPerfil.value = estado.perfil;
            if (spanArquivo) {
                spanArquivo.textContent = estado.regraJson ? 'Configurado' : 'Nenhum arquivo selecionado';
            }
            if (spanUsuario) {
                spanUsuario.textContent = estado.nomeUsuario || 'Usuário';
            }
        }

        function salvarConfig() {
            const selectPerfil = document.getElementById('selectPerfil');
            const inputArquivo = document.getElementById('inputArquivoConfig');

            if (selectPerfil) {
                estado.perfil = selectPerfil.value;
                localStorage.setItem('perfil', estado.perfil);
            }

            if (inputArquivo && inputArquivo.files.length > 0) {
                const arquivo = inputArquivo.files[0];

                const reader = new FileReader();
                reader.onload = function(e) {
                    try {
                        const conteudo = e.target.result;
                        const obj = JSON.parse(conteudo);

                        estado.regraJson = conteudo;
                        estado.userId = obj.userId;
                        estado.nomeUsuario = obj.userName;

                        localStorage.setItem('regra', conteudo);
                        localStorage.setItem('user_id', obj.userId);
                        localStorage.setItem('nome_usuario', obj.userName);

                        mostrarMensagem('Configuração salva com sucesso!');
                        carregarConfigLocal();

                        const modal = bootstrap.Modal.getInstance(document.getElementById('modalConfig'));
                        if (modal) modal.hide();
                    } catch (erro) {
                        mostrarErro('Erro ao ler arquivo JSON: ' + erro.message);
                    }
                };
                reader.readAsText(arquivo, 'UTF-8');
            } else {
                mostrarMensagem('Perfil atualizado!');
                carregarConfigLocal();

                const modal = bootstrap.Modal.getInstance(document.getElementById('modalConfig'));
                if (modal) modal.hide();
            }
        }

        onMounted(function() {
            carregarVersao();
            carregarConfigLocal();
            conectarWebSocket();
            configurarEventListeners();
            renderizarListaGtins();
            renderizarMiniaturas();
        });

        onUnmounted(function() {
            pararMonitoramentoTemp();
            if (estado.websocket) {
                estado.websocket.close();
            }
        });

        return {
            estado,
            buscarGTIN,
            salvar,
            finalizar,
            limparTemp,
            deletarImagem,
            salvarConfig
        };
    }
});

app.mount('#app');
