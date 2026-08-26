import axios from "axios"; // ADICIONADO: Faltava o import para a rota stream-video
import { createHash } from "crypto";
import cors from "cors";
import "dotenv/config";
import express from "express";
import FormData from "form-data";
import { Composer, Markup, Scenes, Telegraf } from "telegraf";
import efiService from "./src/services/efiService.js";
import pool from "./src/services/db.js";

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: {
        apiRoot: 'https://api.telegram.org',
        webhookReply: false
    },
    handlerTimeout: 60000 // Aumenta o timeout para evitar 504
});

bot.catch((err, ctx) => {
  console.error(`[BOT ERROR] Erro silencioso processando atualização para o user ${ctx.from?.id}:`, err.message);
});

// Domínio público onde o Telegram deve entregar as atualizações via webhook.
// Long polling (bot.launch()) é frágil em PaaS como o Railway: a cada deploy o
// container antigo e o novo podem disputar o getUpdates (erro 409 Conflict) e o
// bot fica sem processar comandos até o retry. Webhook elimina essa classe de travamento.
const PUBLIC_DOMAIN = process.env.PUBLIC_URL || "https://melreels.com.br";
// Usa um hash do token (sem ":") em vez do token cru — o ":" dentro de um path
// de URL é atípico o bastante pra causar problemas em alguns parsers de URL
// do lado do Telegram ao registrar/entregar o webhook.
const BOT_WEBHOOK_SECRET = createHash("sha256").update(process.env.BOT_TOKEN).digest("hex");
const BOT_WEBHOOK_PATH = `/telegraf-webhook/${BOT_WEBHOOK_SECRET}`;

// =================================================================
// 0. CACHE EM MEMÓRIA (PERFORMANCE)
// =================================================================
let catalogCache = {
  data: null,
  lastFetch: 0,
};

function invalidarCacheCatalogo() {
    console.log("🧹 [CACHE] Invalidação forçada: Ranking precisa ser atualizado.");
    catalogCache.data = null;
    catalogCache.lastFetch = 0;
}

const CACHE_TTL = 30 * 1000; // 30 segundos de cache para atualização mais rápida do ranking

// URLs base de armazenamento "local" (HDs expostos via Cloudflare Tunnel, ex: https://media.melreels.com.br/filmes)
const STORAGE_BASE_URLS = [
  process.env.STORAGE_PATH_1,
  process.env.STORAGE_PATH_2,
].filter(Boolean);

// Resolve a URL do arquivo checando cada base configurada (HEAD request)
async function resolveVideoUrl(filename) {
  for (const base of STORAGE_BASE_URLS) {
    const url = `${base.replace(/\/$/, "")}/${filename}`;
    try {
      const head = await axios.head(url, { timeout: 5000 });
      if (head.status === 200) return url;
    } catch (e) {
      continue; // Não encontrado nessa base, tenta a próxima
    }
  }
  return null; // Não encontrado em nenhuma base configurada
}


// =================================================================
// 1. CONFIGURAÇÃO DE CENAS (MODO ADMIN FLUXO COMPLETO E TIPADO)
// =================================================================

// --- COMPOSER PARA A ETAPA DE GÊNEROS (Múltipla Escolha) ---
const generosComposer = new Composer();

// Lista de gêneros disponíveis
const listaGeneros = [
  "Free", "Ação e aventura", "Dorama", "Comédia", "Terror", 
  "Ficção científica", "Fantasia", "Romance", "Animação", 
  "Short", "Turcos", "Americano", "+18", "LGBT"
];

function buildGenerosKeyboard(selecionados) {
  const botoes = listaGeneros.map(g => {
    const texto = selecionados.includes(g) ? `${g} ✅` : g;
    return Markup.button.callback(texto, `GENERO_${g}`);
  });
  
  const teclado = [];
  for (let i = 0; i < botoes.length; i += 1) {
    teclado.push([botoes[i]]);
  }
  teclado.push([Markup.button.callback("Próxima", "PROXIMA_GENERO")]);
  teclado.push([Markup.button.callback("Cancelar", "CANCELAR_ADD")]);
  return Markup.inlineKeyboard(teclado);
}

generosComposer.action(/GENERO_(.+)/, async (ctx) => {
  const generoClicado = ctx.match[1];
  let selecionados = ctx.wizard.state.generos || [];
  
  if (selecionados.includes(generoClicado)) {
    selecionados = selecionados.filter(g => g !== generoClicado);
  } else {
    selecionados.push(generoClicado);
  }
  ctx.wizard.state.generos = selecionados;
  await ctx.editMessageReplyMarkup(buildGenerosKeyboard(selecionados).reply_markup);
});

generosComposer.action("PROXIMA_GENERO", async (ctx) => {
  const selecionados = ctx.wizard.state.generos || [];
  if (selecionados.length === 0) {
    return ctx.answerCbQuery("⚠️ Selecione pelo menos um gênero!", { show_alert: true });
  }
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply("Por favor, insira o ID do vídeo do trailer do filme no YouTube (Ou o link completo):");
  return ctx.wizard.next();
});

generosComposer.on("message", async (ctx) => {
  if (!ctx.message || !ctx.message.text) return; // Ignora fotos ou áudios
  
  const novoGenero = ctx.message.text.trim();
  let selecionados = ctx.wizard.state.generos || [];
  
  // Adiciona a palavra que ela digitou na lista de selecionados
  if (!selecionados.includes(novoGenero)) {
    selecionados.push(novoGenero);
  }
  ctx.wizard.state.generos = selecionados;
  
  // Avisa que salvou e mostra os botões de novo caso ela queira clicar em "Próxima"
  await ctx.reply(`✅ A categoria/gênero "${novoGenero}" foi adicionada!\n\nVocê pode clicar nos botões, digitar mais algum, ou clicar em 'Próxima' para continuar:`, buildGenerosKeyboard(selecionados));
});


// --- O WIZARD PRINCIPAL ---
const adicionarDramaScene = new Scenes.WizardScene(
  "ADICIONAR_DRAMA_SCENE",

  // Passo 0: Formato
  async (ctx) => {
    ctx.wizard.state.payload = {}; 
    await ctx.reply("Por favor, selecione o formato do conteúdo:", 
      Markup.inlineKeyboard([
        [Markup.button.callback("Filme", "TIPO_FILME"), Markup.button.callback("Série", "TIPO_SERIE")],
        [Markup.button.callback("Documentário", "TIPO_DOC"), Markup.button.callback("Aula", "TIPO_AULA")],
        [Markup.button.callback("Cancelar", "CANCELAR_ADD")]
      ])
    );
    return ctx.wizard.next();
  },

  // Passo 1: Nome
  async (ctx) => {
    if (ctx.callbackQuery?.data === "CANCELAR_ADD") {
      await ctx.answerCbQuery().catch(()=>{});
      await ctx.deleteMessage().catch(()=>{});
      await ctx.reply("❌ Operação cancelada.");
      return ctx.scene.leave();
    }
    if (ctx.callbackQuery) {
      const mapTipo = { "TIPO_FILME": "FILME", "TIPO_SERIE": "SERIE", "TIPO_DOC": "DOCUMENTARIO", "TIPO_AULA": "AULA" };
      ctx.wizard.state.payload.formato = mapTipo[ctx.callbackQuery.data] || "FILME";
      await ctx.answerCbQuery().catch(()=>{});
      await ctx.deleteMessage().catch(()=>{}); 
    } else {
      return; 
    }
    await ctx.reply("Por favor, insira o TÍTULO do conteúdo:");
    return ctx.wizard.next();
  },

  // Passo 2: Data
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    ctx.wizard.state.payload.nome = ctx.message.text;
    await ctx.reply("Qual a DATA DE LANÇAMENTO? (Digite no formato DD/MM/AAAA. Ex: 25/12/2023)");
    return ctx.wizard.next();
  },

  // Passo 3: Idioma
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return; 
    const dataDigitada = ctx.message.text;
    if (dataDigitada.includes("/")) {
      const [dia, mes, ano] = dataDigitada.split("/");
      if (ano && mes && dia) {
        ctx.wizard.state.payload.data_lancamento = `${ano}-${mes}-${dia}`;
      } else {
        ctx.wizard.state.payload.data_lancamento = null;
      }
    } else {
      ctx.wizard.state.payload.data_lancamento = null;
    }
    await ctx.reply("Por favor, insira o IDIOMA (Ex: PT-BR, Legendado, Coreano):");
    return ctx.wizard.next();
  },

  // Passo 4: Descrição
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    ctx.wizard.state.payload.idioma = ctx.message.text;
    await ctx.reply("Por favor, insira a DESCRIÇÃO completa (Sinopse):");
    return ctx.wizard.next();
  },

  // Passo 5: Gêneros
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    ctx.wizard.state.payload.descricao = ctx.message.text;
    ctx.wizard.state.generos = []; 
    await ctx.reply("Selecione os gêneros abaixo **OU digite uma nova categoria** diretamente aqui no chat:", buildGenerosKeyboard([]));
    return ctx.wizard.next();
  },

  generosComposer, // Passo 6 (Composer que renderiza os botões)

  // Passo 7: Preço Aluguel
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    ctx.wizard.state.payload.trailer = ctx.message.text;
    await ctx.reply("Qual o preço do ALUGUEL? (Ex: 8.50)\n*Digite 0 se não for alugável.*");
    return ctx.wizard.next();
  },

  // Passo 8: Preço Vitalício
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const pAluguel = parseFloat(ctx.message.text.replace(",", "."));
    ctx.wizard.state.payload.preco_aluguel = isNaN(pAluguel) ? 0 : pAluguel;
    await ctx.reply("Qual o preço VITALÍCIO (Para toda a vida)? (Ex: 15.00)");
    return ctx.wizard.next();
  },

  // Passo 9: Banner
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const pVit = parseFloat(ctx.message.text.replace(",", "."));
    ctx.wizard.state.payload.preco_vitalicio = isNaN(pVit) ? 0 : pVit;
    await ctx.reply("Envie a URL do BANNER (Capa do Filme):");
    return ctx.wizard.next();
  },

  // Passo 10: Duração
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    ctx.wizard.state.payload.banner = ctx.message.text;
    await ctx.reply("Qual a DURAÇÃO do conteúdo?\n*(Digite em horas e minutos, ex: 01:30)*");
    return ctx.wizard.next();
  },

  // Passo 11: Arquivo Local / Telegram ID
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const duracaoTexto = ctx.message.text;
    let minutosTotais = 0;
    if (duracaoTexto.includes(":")) {
      const [horas, minutos] = duracaoTexto.split(":");
      minutosTotais = (parseInt(horas) || 0) * 60 + (parseInt(minutos) || 0);
    } else {
      minutosTotais = parseInt(duracaoTexto) || 0;
    }
    ctx.wizard.state.payload.duracao = minutosTotais;
    
    
    await ctx.reply("💻 Envie o **NOME DO ARQUIVO LOCAL** (ex: dorama.mp4) ou o **FILE ID DO TELEGRAM**:", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // Passo 12: Link Bunny.net (Recebe o Vídeo/ID e pede o Bunny)
  async (ctx) => {
    let videoId = "";

    // 1. Se o admin mandou um texto (ex: filme.mp4 ou colou o ID na mão)
    if (ctx.message && ctx.message.text) {
        videoId = ctx.message.text.trim();
    } 
    // 2. 🚀 A MÁGICA: Se o admin encaminhou o próprio VÍDEO direto no chat!
    else if (ctx.message && ctx.message.video) {
        videoId = ctx.message.video.file_id;
    } 
    // 3. Se mandou como arquivo de documento sem querer
    else if (ctx.message && ctx.message.document) {
        videoId = ctx.message.document.file_id;
    } 
    // Se mandar foto ou sticker, o escudo bloqueia e espera
    else {
        return; 
    }

    ctx.wizard.state.payload.video_id = videoId;
    await ctx.reply("🐇 Envie a **URL DO BUNNY.NET** para este conteúdo.\n\n*(Se não for usar o Bunny, digite **PULAR**)*", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // Passo 13: Fonte Prioritária
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    let bunnyUrl = ctx.message.text.trim();
    ctx.wizard.state.payload.bunny_url = (bunnyUrl.toUpperCase() === "PULAR") ? null : bunnyUrl;
    await ctx.reply("🔁 Qual será a **FONTE PRIORITÁRIA** de streaming?\n\nDigite apenas uma das opções:\n**LOCAL**\n**BUNNY**\n**TELEGRAM**", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // Passo 14: Salva no Banco
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    let fonte = ctx.message.text.trim().toUpperCase();
    
    if (!["LOCAL", "BUNNY", "TELEGRAM"].includes(fonte)) {
        fonte = "LOCAL"; 
    }
    
    const p = ctx.wizard.state.payload;
    const generosFinais = ctx.wizard.state.generos.join(", "); 

    try {
      await pool.query(
        `INSERT INTO "CONTEUDOS" (nm_titulo, nm_categoria, tp_formato, dt_lancamento, nm_idioma, ds_descricao, ds_generos, ds_url_trailer_youtube, nr_duracao_minutos, vl_aluguel, vl_vitalicio, ds_url_poster, ds_file_id_telegram, ds_url_bunny, tp_fonte_prioritaria, sn_destaque)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          p.nome,
          ctx.wizard.state.generos[0],
          p.formato,
          p.data_lancamento,
          p.idioma,
          p.descricao,
          generosFinais,
          p.trailer,
          p.duracao,
          p.preco_aluguel,
          p.preco_vitalicio,
          p.banner,
          p.video_id,
          p.bunny_url,
          fonte,
          false
        ]
      );

      catalogCache.data = null;

      await ctx.reply(
        `✅ **Cadastro Concluído (Padrão V2)!**\n\n` +
        `🍿 **${p.nome}** (${p.formato})\n` +
        `📡 Fonte: **${fonte}**\n` +
        `⏱️ ${p.duracao} min | 💰 R$${p.preco_aluguel}`, 
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("❌ [ERRO DB CADASTRO]:", err.message);
      await ctx.reply("❌ Erro ao salvar no banco. Verifique as colunas da tabela.");
    }
    return ctx.scene.leave();
  }
);

// =================================================================
// 🎬 FLUXO ADMIN: ADICIONAR EPISÓDIO
// =================================================================
const adicionarEpisodioScene = new Scenes.WizardScene(
  "ADICIONAR_EPISODIO_SCENE",
  
  // Passo 1: Pede o ID da Série
  async (ctx) => {
    await ctx.reply("📺 **Adicionar Episódio:**\n\nEnvie o `ID da Série` (Você pode pegar usando o comando /buscar):", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  
  // Passo 2: Pede os dados do Episódio (Agora aceita Link ou ID)
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    
    let textoDigitado = ctx.message.text.trim();
    
    // 🚀 O PULO DO GATO: Se ela colar o link inteiro, nós extraímos só o UUID!
    if (textoDigitado.includes("start=")) {
        textoDigitado = textoDigitado.split("start=")[1].trim();
    }
    
    ctx.wizard.state.serieId = textoDigitado;
    
    await ctx.reply("📝 Envie o número e o nome do episódio no formato: `Número - Nome`\n*(Exemplo: 1 - O Início de Tudo)*", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  
  // Passo 3: Pede o Vídeo para pegar o File ID
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const [num, ...nomeArr] = ctx.message.text.split("-");
    
    ctx.wizard.state.nrEpisodio = parseInt(num.trim());
    ctx.wizard.state.nmEpisodio = nomeArr.join("-").trim() || `Episódio ${ctx.wizard.state.nrEpisodio}`;
    
    await ctx.reply(`🎬 Quase lá! Envie agora o **Arquivo de Vídeo** do Episódio ${ctx.wizard.state.nrEpisodio}:`);
    return ctx.wizard.next();
  },

  // Passo 4: Salva no Banco
  async (ctx) => {
    if (!ctx.message || !ctx.message.video) {
        await ctx.reply("❌ Você precisa enviar um vídeo válido. Operação cancelada.");
        return ctx.scene.leave();
    }

    const fileId = ctx.message.video.file_id;
    
    try {
        await pool.query(
            `INSERT INTO "EPISODIOS" (cd_conteudo, nr_episodio, nm_titulo, ds_file_id_telegram) VALUES ($1, $2, $3, $4)`,
            [ctx.wizard.state.serieId, ctx.wizard.state.nrEpisodio, ctx.wizard.state.nmEpisodio, fileId]
        );

        await ctx.reply(`✅ **Episódio ${ctx.wizard.state.nrEpisodio} adicionado com sucesso!**`, { parse_mode: "Markdown" });

        // 🔔 Avisa quem já tá assistindo essa série, sem travar a resposta pro admin
        notificarNovoEpisodio(ctx.wizard.state.serieId, ctx.wizard.state.nrEpisodio, ctx.wizard.state.nmEpisodio).catch(() => {});
    } catch (e) {
        console.error("Erro ao salvar episódio:", e.message);
        await ctx.reply("❌ Erro ao salvar no banco de dados.");
    }
    return ctx.scene.leave();
  }
);

// E lá nos seus comandos, ative a cena:
bot.command("add_ep", (ctx) => {
    const admins = process.env.ADMIN_IDS.split(",");
    if (admins.includes(ctx.from.id.toString())) {
        ctx.scene.enter("ADICIONAR_EPISODIO_SCENE");
    }
});

// Listener Global para cancelar a qualquer momento
adicionarDramaScene.action("CANCELAR_ADD", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("❌ Operação de adição cancelada.");
  return ctx.scene.leave();
});

adicionarDramaScene.command("cancelar", async (ctx) => {
  await ctx.reply("❌ Cadastro cancelado. Você saiu da ferramenta de adição.");
  return ctx.scene.leave();
});

// --- CENA COMPLETA E CORRIGIDA: GERENCIAMENTO DE CLIENTE ---
const gerenciarClienteScene = new Scenes.WizardScene(
  "GERENCIAR_CLIENTE_SCENE",

  // Passo 1: Pedir o ID
  async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("👤 **GERENCIAMENTO DE USUÁRIO**\n\nPor favor, digite o **ID do Telegram** do cliente:", { 
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "CANCELAR_GERENCIAMENTO" }]] }
    });
    return ctx.wizard.next();
  },

  // Passo 2: Mostrar Menu (Atualizado com Relatório e Link do Cliente)
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
        if (ctx.callbackQuery?.data === "CANCELAR_GERENCIAMENTO") {
            await ctx.answerCbQuery();
            await ctx.editMessageText("❌ Operação cancelada.");
            return ctx.scene.leave();
        }
        return;
    }

    const userId = ctx.message.text.trim();
    ctx.wizard.state.clienteId = userId;

    const loadingMsg = await ctx.reply("⌛ *Minerando dados do cliente...*", { parse_mode: "Markdown" });
    
    try {
        // 🚀 O PULO DO GATO: Tenta buscar o Nome e o @ do cliente no Telegram
        let nomeCliente = "Usuário";
        let usernameCliente = "";
        try {
            const chatCliente = await ctx.telegram.getChat(userId);
            
            // 🛡️ FILTRO SÊNIOR: Limpa TUDO que for caractere estranho pra não crashar o bot
            nomeCliente = (chatCliente.first_name || "Usuário").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "");
            
            if (chatCliente.username) {
                // Remove caracteres problemáticos do username também, por via das dúvidas
                const safeUser = chatCliente.username.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "");
                usernameCliente = `\n💬 *Username:* @${safeUser}`;
            }
        } catch (e) {
            console.log("Aviso: Bot não conseguiu buscar info detalhada do user " + userId);
        }

        // 1. Checa se tá banido
        const { rows: banRows } = await pool.query('SELECT * FROM "BANS" WHERE nr_id_telegram = $1 LIMIT 1', [userId]);
        const ban = banRows[0];
        const isBanned = !!ban;

        // 2. BUSCA O HISTÓRICO COMPLETO DE COMPRAS
        const { rows: historico } = await pool.query(
            `SELECT v.cd_venda, v.tp_compra, v.tp_status, v.ts_criacao, v.ts_atualizacao, v.ts_expiracao, v.ds_txid,
                    c.nm_titulo AS "conteudoTitulo", p.nm_plano AS "planoNome"
             FROM "VENDAS" v
             LEFT JOIN "CONTEUDOS" c ON c.cd_conteudo = v.cd_conteudo
             LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
             WHERE v.nr_id_telegram = $1
             ORDER BY v.ts_criacao DESC`,
            [userId]
        );

        // 3. MONTA O RELATÓRIO DETALHADO (Arquivo TXT)
        let logContent = `===================================================\n 📊 RELATÓRIO DE AUDITORIA - MELREELS\n===================================================\n\n👤 ID DO USUÁRIO: ${userId}\n🚦 STATUS DA CONTA: ${isBanned ? '🔴 BANIDO' : '🟢 ATIVO'}\n📅 DATA DA EXTRAÇÃO: ${new Date().toLocaleString('pt-BR')}\n🛒 TOTAL DE INTERAÇÕES: ${historico ? historico.length : 0}\n\n---------------------------------------------------\n 📜 HISTÓRICO DE SOLICITAÇÕES E COMPRAS\n---------------------------------------------------\n\n`;

        if (!historico || historico.length === 0) {
            logContent += `Nenhum registro encontrado para este usuário.\n`;
        } else {
            historico.forEach((v, index) => {
                const itemNome = v.tp_compra === "ASSINATURA" ? v.planoNome : v.conteudoTitulo;
                const dataSolicitacao = v.ts_criacao ? new Date(v.ts_criacao).toLocaleString('pt-BR') : 'N/D';
                const dataAtualizacao = v.ts_atualizacao ? new Date(v.ts_atualizacao).toLocaleString('pt-BR') : 'N/D';
                const dataExpiracao = v.ts_expiracao ? new Date(v.ts_expiracao).toLocaleString('pt-BR') : 'N/D';
                
                logContent += `[${index + 1}] ITEM: ${itemNome || 'Conteúdo Excluído'}\n    🔹 Modalidade: ${v.tp_compra}\n`;
                if (v.tp_status === "APROVADA") {
                    logContent += `    🟢 Status: APROVADA\n    📅 Solicitado em: ${dataSolicitacao}\n    ✅ Pago/Liberado em: ${dataAtualizacao}\n    ⏳ Expira em: ${dataExpiracao}\n`;
                } else {
                    logContent += `    🟡 Status: ${v.tp_status}\n    📅 Solicitado em: ${dataSolicitacao}\n    ❌ Pagamento: Aguardando ou Expirado\n`;
                }
                if (v.ds_txid) logContent += `    🧾 TXID (Pix): ${v.ds_txid}\n`;
                logContent += `    🔑 ID Sistema: ${v.cd_venda}\n\n`;
            });
        }
        logContent += `===================================================\n FIM DO RELATÓRIO\n===================================================`;

        // 4. Envia o arquivo pro Admin (COM ESCUDO ANTI-TIMEOUT)
        try {
            await ctx.replyWithDocument(
                { source: Buffer.from(logContent), filename: `Auditoria_${userId}.txt` },
                { caption: `✅ Relatório de compras extraído.`, parse_mode: "Markdown" }
            );
        } catch (uploadErr) {
            console.error("⚠️ Falha de upload do relatório (Timeout/Net Local):", uploadErr.message);
            await ctx.reply("⚠️ *Aviso:* O relatório foi gerado, mas o envio do arquivo falhou por lentidão na rota de internet local (Timeout). O painel do cliente abrirá a seguir.", { parse_mode: "Markdown" });
        }

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

        // 5. 🚀 Continua abrindo o Painel de Ações normal (Mudamos para HTML para não ter problema com caracteres!)
        await ctx.reply(
            `📑 <b>PAINEL DO CLIENTE</b>\n\n` +
            `👤 <b>Nome:</b> <a href="tg://user?id=${userId}">${nomeCliente}</a>` + 
            `${usernameCliente}\n` +
            `🆔 <b>ID:</b> <code>${userId}</code>\n` +
            `🚦 <b>Status:</b> ${isBanned ? "🔴 BANIDO" : "🟢 ATIVO"}\n\n` +
            `O que deseja fazer?`,
            {
                parse_mode: "HTML", // 🚀 A SOLUÇÃO DEFINITIVA
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📊 Ver Assinaturas Ativas", callback_data: "CLIENTE_INFOS" }],
                        [
                            { text: "➕ Add Filme", callback_data: "CLIENTE_DAR_ACESSO" },
                            { text: "🗑️ Tirar Filme", callback_data: "CLIENTE_REMOVER_ACESSO" }
                        ],
                        [
                            { text: "👑 Dar Plano / VIP", callback_data: "CLIENTE_DAR_PLANO" },
                            { text: "➖ Resetar Tudo", callback_data: "CLIENTE_CLEAR_ALL" }
                        ],
                        [
                            { text: isBanned ? "🔓 Desbanir" : "🚫 Banir Cliente", callback_data: "CLIENTE_TOGGLE_BAN" },
                            { text: "❌ Sair", callback_data: "CANCELAR_GERENCIAMENTO" }
                        ]
                    ]
                }
            }
        );
        return ctx.wizard.next();
    } catch (err) {
        console.error(err);
        await ctx.reply("❌ Erro ao buscar usuário ou montar relatório.");
        return ctx.scene.leave();
    }
  },
  
  // Passo 3: O Cérebro das Ações
  async (ctx) => {
    if (!ctx.callbackQuery) {
        await ctx.reply("⚠️ Ação inválida ou expirada. Envie /admin para começar de novo.");
        return ctx.scene.leave();
    }
    const acao = ctx.callbackQuery.data;
    const userId = ctx.wizard.state.clienteId;
    await ctx.answerCbQuery().catch(() => {});

    if (acao === "CANCELAR_GERENCIAMENTO") {
        await ctx.editMessageText("✅ Sessão encerrada.");
        return ctx.scene.leave();
    }

    if (acao === "CLIENTE_INFOS") {
        const agora = new Date().toISOString();
        const { rows: vendas } = await pool.query(
            `SELECT v.cd_conteudo, v.tp_compra, v.ts_expiracao,
                    c.nm_titulo AS "conteudoTitulo", p.nm_plano AS "planoNome"
             FROM "VENDAS" v
             LEFT JOIN "CONTEUDOS" c ON c.cd_conteudo = v.cd_conteudo
             LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
             WHERE v.nr_id_telegram = $1 AND v.tp_status = $2 AND v.ts_expiracao > $3
             ORDER BY v.ts_expiracao ASC`,
            [userId, "APROVADA", agora]
        );

		invalidarCacheCatalogo();

        if (!vendas || vendas.length === 0) return ctx.reply("❌ Este usuário não possui assinaturas ativas.");

        const loadingMsg = await ctx.reply("⏳ Gerando relatório oficial em PDF...");

        try {
            // Importa o gerador de PDF
            const PDFDocument = (await import('pdfkit')).default;
            
            // Cria o documento em branco
            const doc = new PDFDocument({ margin: 50 });
            let buffers = [];

            // Captura os dados gerados na memória
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', async () => {
                const pdfData = Buffer.concat(buffers);
                
                // Envia o arquivo PDF direto no chat
                await ctx.replyWithDocument(
                    { source: pdfData, filename: `Assinaturas_ID_${userId}.pdf` },
                    { caption: `📄 **Relatório de Assinaturas**\n👤 ID do Cliente: \`${userId}\``, parse_mode: "Markdown" }
                );
                await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
            });

            // ==========================================
            // DESIGN DO PDF
            // ==========================================
            doc.fillColor('#E50914').fontSize(24).font('Helvetica-Bold').text('MELREELS', { align: 'center' });
            doc.fillColor('#333333').fontSize(12).font('Helvetica').text('Relatório Oficial de Assinaturas', { align: 'center' });
            doc.moveDown(2);

            // Informações do Cliente
            doc.fontSize(14).font('Helvetica-Bold').text('Detalhes do Cliente');
            doc.fontSize(10).font('Helvetica').text(`Telegram ID: ${userId}`);
            doc.text(`Data de Emissão: ${new Date().toLocaleDateString('pt-BR')}`);
            doc.moveDown(2);

            // Título da Lista
            doc.fontSize(12).font('Helvetica-Bold').text('Lista de Conteúdos Liberados:');
            doc.moveDown(0.5);

            // Popula a Lista do Banco de Dados
            vendas.forEach((v, index) => {
                const nome = v.tp_compra === "ASSINATURA" ? `Plano VIP: ${v.planoNome}` : `🎬 ${v.conteudoTitulo}`;
                const dataVenc = new Date(v.ts_expiracao).toLocaleDateString('pt-BR');
                
                doc.fontSize(10).font('Helvetica-Bold').fillColor('#111111').text(`${index + 1}. ${nome}`);
                doc.fontSize(9).font('Helvetica').fillColor('#555555').text(`Expira em: ${dataVenc}`);
                doc.moveDown(0.5);
            });

            // Rodapé Oficial
            doc.moveDown(2);
            doc.fontSize(8).fillColor('#aaaaaa').text('Gerado automaticamente pelo Sistema Administrativo Melreels', { align: 'center' });

            // Finaliza e engatilha o envio
            doc.end();

        } catch (err) {
            console.error("❌ Erro ao gerar PDF:", err);
            await ctx.reply("❌ Ocorreu um erro interno ao gerar o arquivo PDF.");
            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
        }
        return;
    }

    // 🎯 MUDANÇA AQUI: Inicia o fluxo de dar plano listando do banco
    if (acao === "CLIENTE_DAR_PLANO") {
        ctx.wizard.state.subAcao = "DAR_PLANO";
        const { rows: planos } = await pool.query('SELECT * FROM "PLANOS" ORDER BY vl_plano ASC');

        if (!planos || planos.length === 0) {
            await ctx.reply("❌ Nenhum plano encontrado. Crie um plano primeiro!");
            return ctx.scene.leave();
        }

        // Monta os botões dinamicamente com todos os planos do banco
        const botoesPlanos = planos.map(p => [{
            text: `💎 ${p.nm_plano} (${p.nm_categoria})`,
            callback_data: `PLANO_${p.cd_plano}`
        }]);
        botoesPlanos.push([{ text: "❌ Cancelar", callback_data: "CANCELAR_GERENCIAMENTO" }]);

        await ctx.reply("📦 **Selecione qual PLANO você quer dar para o cliente:**", {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: botoesPlanos }
        });
        return ctx.wizard.next();
    }

    if (acao === "CLIENTE_REMOVER_ACESSO") {
        ctx.wizard.state.subAcao = "REMOVER";
        await ctx.reply("🗑️ Envie o **ID (UUID)** do filme que deseja REMOVER do cliente:");
        return ctx.wizard.next();
    }

    if (acao === "CLIENTE_DAR_ACESSO") {
        ctx.wizard.state.subAcao = "ADICIONAR";
        await ctx.reply("🎬 Envie o **ID (UUID)** do filme que deseja LIBERAR para o cliente:");
        return ctx.wizard.next();
    }

    if (acao === "CLIENTE_TOGGLE_BAN") {
        const { rows: banRows2 } = await pool.query('SELECT * FROM "BANS" WHERE nr_id_telegram = $1 LIMIT 1', [userId]);
        const ban = banRows2[0];
        if (ban) {
            await pool.query('DELETE FROM "BANS" WHERE nr_id_telegram = $1', [userId]);
            await ctx.reply(`🔓 Cliente \`${userId}\` DESBANIDO.`);
        } else {
            await pool.query('INSERT INTO "BANS" (nr_id_telegram) VALUES ($1)', [userId]);
            await ctx.reply(`🚫 Cliente \`${userId}\` BANIDO.`);
        }
        return ctx.scene.leave();
    }

    if (acao === "CLIENTE_CLEAR_ALL") {
        await pool.query('UPDATE "VENDAS" SET ts_expiracao = $1 WHERE nr_id_telegram = $2', [new Date().toISOString(), userId]);
        await ctx.reply("🗑️ Todos os acessos foram expirados/resetados.");
        return ctx.scene.leave();
    }
  },

  // Passo 4: Receber Opção do Plano ou ID do Filme
  async (ctx) => {
    const subAcao = ctx.wizard.state.subAcao;

    if (subAcao === "DAR_PLANO") {
        if (!ctx.callbackQuery) {
            await ctx.reply("⚠️ Ação inválida ou expirada. Envie /admin para começar de novo.");
            return ctx.scene.leave();
        }
        if (ctx.callbackQuery.data === "CANCELAR_GERENCIAMENTO") {
            await ctx.answerCbQuery().catch(()=>{});
            await ctx.editMessageText("❌ Operação cancelada.");
            return ctx.scene.leave();
        }
        if (!ctx.callbackQuery.data.startsWith("PLANO_")) {
            await ctx.answerCbQuery().catch(()=>{});
            await ctx.reply("⚠️ Ação inválida ou expirada. Envie /admin para começar de novo.");
            return ctx.scene.leave();
        }

        const planId = ctx.callbackQuery.data.replace("PLANO_", "");
        ctx.wizard.state.planId = planId;
        await ctx.answerCbQuery().catch(()=>{});

        // 🚀 ADICIONADO O BOTÃO DE DIAS CUSTOMIZADOS AQUI
        await ctx.editMessageText("⏱️ **Qual a DURAÇÃO do acesso?**", {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📅 1 Mês (30d)", callback_data: "DURACAO_30" }, { text: "📅 2 Meses (60d)", callback_data: "DURACAO_60" }],
                    [{ text: "📅 3 Meses (90d)", callback_data: "DURACAO_90" }, { text: "📅 6 Meses (180d)", callback_data: "DURACAO_180" }],
                    [{ text: "♾️ Vitalício", callback_data: "DURACAO_7300" }, { text: "⌨️ Custom (Digitar Dias)", callback_data: "DURACAO_CUSTOM" }],
                    [{ text: "❌ Cancelar", callback_data: "CANCELAR_GERENCIAMENTO" }]
                ]
            }
        });
        return ctx.wizard.next();
    }

    // Logica original de Filme
    if (!ctx.message || !ctx.message.text) return;
    ctx.wizard.state.conteudoId = ctx.message.text.trim();

    if (subAcao === "REMOVER") {
        await pool.query(
            'UPDATE "VENDAS" SET ts_expiracao = $1 WHERE nr_id_telegram = $2 AND cd_conteudo = $3',
            [new Date().toISOString(), ctx.wizard.state.clienteId, ctx.wizard.state.conteudoId]
        );
        await ctx.reply("✅ Filme removido da lista do cliente.");
        return ctx.scene.leave();
    }

    await ctx.reply("💳 Qual a modalidade?", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "⏱️ Aluguel", callback_data: "TIPO_ALUGUEL" }],
                [{ text: "💎 Vitalício", callback_data: "TIPO_VITALICIO" }]
            ]
        }
    });
    return ctx.wizard.next();
  },

  // Passo 5: Finalizar Inserção no Banco
  async (ctx) => {
    const { clienteId, subAcao } = ctx.wizard.state;

    // Se o admin clicou em cancelar em qualquer momento
    if (ctx.callbackQuery && ctx.callbackQuery.data === "CANCELAR_GERENCIAMENTO") {
        await ctx.answerCbQuery().catch(()=>{});
        await ctx.editMessageText("❌ Operação cancelada.");
        return ctx.scene.leave();
    }

    if (subAcao === "DAR_PLANO") {
        let dias = 0;

        // 1. 🚀 O Admin clicou no botão "Custom (Digitar Dias)"
        if (ctx.callbackQuery && ctx.callbackQuery.data === "DURACAO_CUSTOM") {
            ctx.wizard.state.esperandoDiasCustom = true;
            await ctx.answerCbQuery().catch(()=>{});
            await ctx.editMessageText("⌨️ **Migração de Cliente:**\n\nDigite a quantidade exata de **DIAS** que este cliente ainda tem direito (Ex: 4, 16, 45):", { parse_mode: "Markdown" });
            return; // Escudo: Para aqui e espera o Admin digitar a próxima mensagem
        }

        // 2. 🚀 O Admin digitou um texto com o número de dias
        if (ctx.wizard.state.esperandoDiasCustom) {
            if (!ctx.message || !ctx.message.text) return; // Ignora se mandar foto/sticker
            dias = parseInt(ctx.message.text.trim());
            
            if (isNaN(dias)) {
                await ctx.reply("❌ Valor inválido. Digite apenas números inteiros (Ex: 16).");
                return; // Pede pra digitar de novo
            }
        } 
        // 3. O Admin clicou em um dos botões prontos (30, 60, etc)
        else if (ctx.callbackQuery && ctx.callbackQuery.data.startsWith("DURACAO_")) {
            dias = parseInt(ctx.callbackQuery.data.replace("DURACAO_", ""));
            await ctx.answerCbQuery().catch(()=>{});
        } else {
            return; // Ignora qualquer outra coisa
        }

        // --- SALVANDO NO BANCO ---
        const expira = new Date();
        expira.setDate(expira.getDate() + dias);

        try {
            await pool.query(
                'DELETE FROM "VENDAS" WHERE nr_id_telegram = $1 AND cd_plano = $2',
                [clienteId, ctx.wizard.state.planId]
            );

            await pool.query(
                `INSERT INTO "VENDAS" (nr_id_telegram, cd_plano, tp_compra, tp_status, ts_expiracao) VALUES ($1, $2, $3, $4, $5)`,
                [clienteId, ctx.wizard.state.planId, "ASSINATURA", "APROVADA", expira.toISOString()]
            );

            // Responde como texto se veio de digitação, ou edita se veio do botão
            const msgResponse = ctx.message ? ctx.reply.bind(ctx) : ctx.editMessageText.bind(ctx);
            await msgResponse(`✅ **Plano liberado com sucesso!**\nDuração programada para: ${dias} dias.`, { parse_mode: "Markdown" });
            
            await bot.telegram.sendMessage(clienteId, "👑 **SEU PLANO FOI ATUALIZADO!**\nAbra o aplicativo para assistir.").catch(() => {});
        } catch (e) {
            console.error("❌ ERRO DAR PLANO:", e.message);
            await ctx.reply("❌ Erro ao liberar plano no banco de dados.");
        }
        return ctx.scene.leave();
    }

    // Lógica original de Inserir Filme
    if (!ctx.callbackQuery) {
        await ctx.reply("⚠️ Ação inválida ou expirada. Envie /admin para começar de novo.");
        return ctx.scene.leave();
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery().catch(()=>{});

    const { conteudoId } = ctx.wizard.state;
    const diasFilme = (data === "TIPO_ALUGUEL") ? 7 : 18250;
    const expiraFilme = new Date();
    expiraFilme.setDate(expiraFilme.getDate() + diasFilme);

    try {
        await pool.query(
            'DELETE FROM "VENDAS" WHERE nr_id_telegram = $1 AND cd_conteudo = $2',
            [clienteId, conteudoId]
        );

        await pool.query(
            `INSERT INTO "VENDAS" (nr_id_telegram, cd_conteudo, tp_compra, tp_status, ts_expiracao) VALUES ($1, $2, $3, $4, $5)`,
            [clienteId, conteudoId, (data === "TIPO_ALUGUEL") ? "ALUGUEL" : "VITALICIO", "APROVADA", expiraFilme.toISOString()]
        );

        await ctx.editMessageText(`✅ Acesso ${data === "TIPO_ALUGUEL" ? "Alugado (7 dias)" : "Vitalício"} liberado!`);
        await bot.telegram.sendMessage(clienteId, "🎁 Novo conteúdo liberado na sua lista!").catch(() => {});
    } catch (e) {
        console.error("❌ ERRO DAR ACESSO:", e.message);
        await ctx.reply("❌ Erro ao liberar acesso no banco de dados.");
    }
    return ctx.scene.leave();
  }
);

const excluirConteudoScene = new Scenes.WizardScene(
  "EXCLUIR_CONTEUDO_SCENE",
  
  
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    await ctx.reply("🗑️ **EXCLUIR CONTEÚDO**\n\nEnvie o **ID (UUID)** do filme/série que deseja deletar:\n*(Você pode pegar esse ID abrindo o filme no Mini App e olhando o link, ou consultando o banco)*", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  
  
  async (ctx) => {
    const conteudoId = ctx.message.text.trim();
    
    try {

      const { rows: filmeRows } = await pool.query(
        'SELECT nm_titulo FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1',
        [conteudoId]
      );
      const filme = filmeRows[0];

      if (!filme) {
        await ctx.reply("❌ Nenhum conteúdo encontrado com esse ID.");
        return ctx.scene.leave();
      }


      await pool.query('DELETE FROM "CONTEUDOS" WHERE cd_conteudo = $1', [conteudoId]);


      catalogCache.data = null;

      await ctx.reply(`✅ O conteúdo **${filme.nm_titulo}** foi excluído permanentemente do catálogo!`, { parse_mode: "Markdown" });
      
    } catch (err) {
      console.error("❌ [ERRO DELETE]:", err.message);
      await ctx.reply("❌ Erro ao tentar excluir o conteúdo. Ele pode estar vinculado a vendas ativas.");
    }
    
    return ctx.scene.leave();
  }
);

const atualizarFilmeScene = new Scenes.WizardScene(
  "ATUALIZAR_FILME_SCENE",

  // Passo 1: Pedir o ID do filme
  async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("🔄 **ATUALIZAR INFORMAÇÕES**\n\nPor favor, insira o **ID (UUID)** do filme que deseja editar:", {
      reply_markup: { inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "CANCELAR_EDIT" }]] }
    });
    return ctx.wizard.next();
  },

  // Passo 2: Validar filme e mostrar Grade de Opções
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      if (ctx.callbackQuery?.data === "CANCELAR_EDIT") {
        await ctx.answerCbQuery();
        await ctx.editMessageText("❌ Operação cancelada.");
        return ctx.scene.leave();
      }
      return;
    }

    const conteudoId = ctx.message.text.trim();
    ctx.wizard.state.conteudoId = conteudoId;

    const { rows: filmeRows } = await pool.query('SELECT * FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1', [conteudoId]);
    const filme = filmeRows[0];

    if (!filme) {
      await ctx.reply("❌ Filme não encontrado. Verifique o ID e tente novamente.");
      return ctx.scene.leave();
    }

    ctx.wizard.state.nomeFilme = filme.nm_titulo;

    // 🚀 MUDANÇA AQUI: Adicionado Bunny e Fonte Prioritária
    await ctx.reply(`🛠️ **Editando:** ${filme.nm_titulo}\n\nSelecione o campo que deseja alterar:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Nome", callback_data: "EDIT_nm_titulo" }, { text: "Categoria", callback_data: "EDIT_nm_categoria" }],
          [{ text: "Descrição", callback_data: "EDIT_ds_descricao" }, { text: "Gêneros", callback_data: "EDIT_ds_generos" }],
          [{ text: "Preço", callback_data: "EDIT_vl_aluguel" }, { text: "Preço Vitalício", callback_data: "EDIT_vl_vitalicio" }],
          [{ text: "Ano Lanç.", callback_data: "EDIT_dt_lancamento" }, { text: "Idioma", callback_data: "EDIT_nm_idioma" }],
          [{ text: "Tempo Vídeo", callback_data: "EDIT_nr_duracao_minutos" }, { text: "Trailer (YT)", callback_data: "EDIT_ds_url_trailer_youtube" }],
          [{ text: "Banner", callback_data: "EDIT_ds_url_poster" }, { text: "Link Bunny", callback_data: "EDIT_ds_url_bunny" }],
          [{ text: "ID Local/TG", callback_data: "EDIT_ds_file_id_telegram" }, { text: "🔁 Fonte", callback_data: "EDIT_tp_fonte_prioritaria" }],
          [{ text: "❌ Cancelar", callback_data: "CANCELAR_EDIT" }]
        ]
      }
    });
    return ctx.wizard.next();
  },

  // Passo 3: Identificar o campo escolhido
  async (ctx) => {
    if (!ctx.callbackQuery) {
        await ctx.reply("⚠️ Ação inválida ou expirada. Envie /admin para começar de novo.");
        return ctx.scene.leave();
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (data === "CANCELAR_EDIT") {
      await ctx.editMessageText("❌ Edição cancelada.");
      return ctx.scene.leave();
    }

    const coluna = data.replace("EDIT_", "");
    ctx.wizard.state.colunaParaEditar = coluna;

    const nomesAmigaveis = {
      nm_titulo: "o NOVO NOME",
	  nm_categoria: "a NOVA CATEGORIA (Ex: Dorama, Filme, Short)",
      ds_descricao: "a NOVA DESCRIÇÃO",
      vl_aluguel: "o NOVO PREÇO ALUGUEL (Ex: 8.50)",
      vl_vitalicio: "o NOVO PREÇO VITALÍCIO",
      dt_lancamento: "a NOVA DATA (AAAA-MM-DD)",
      nm_idioma: "o NOVO IDIOMA",
      ds_generos: "os NOVOS GÊNEROS",
      nr_duracao_minutos: "a NOVA DURAÇÃO (minutos)",
      ds_url_trailer_youtube: "o NOVO LINK DO TRAILER",
      ds_url_poster: "a NOVA URL DO BANNER",
      ds_file_id_telegram: "o NOVO ARQUIVO LOCAL / ID",
      ds_url_bunny: "o NOVO LINK DO BUNNY.NET",
      tp_fonte_prioritaria: "a FONTE (Digite apenas: LOCAL, BUNNY ou TELEGRAM)"
    };

    await ctx.reply(`✍️ Digite ${nomesAmigaveis[coluna]} para "${ctx.wizard.state.nomeFilme}":`);
    return ctx.wizard.next();
  },
  // Passo 4: Salvar no Banco e Finalizar
  async (ctx) => {
    let novoValor = "";
    const coluna = ctx.wizard.state.colunaParaEditar;
    const conteudoId = ctx.wizard.state.conteudoId;

    // 🚀 A MÁGICA APLICADA: Agora aceita vídeo encaminhado se estiver editando o ID!
    if (ctx.message && ctx.message.text) {
        novoValor = ctx.message.text.trim();
    } else if (ctx.message && ctx.message.video && coluna === "ds_file_id_telegram") {
        novoValor = ctx.message.video.file_id; // Extrai o ID do vídeo!
    } else if (ctx.message && ctx.message.document && coluna === "ds_file_id_telegram") {
        novoValor = ctx.message.document.file_id; // Extrai o ID se for documento!
    } else {
        return; // Escudo: Ignora se mandar algo nada a ver e continua esperando
    }

    // Tratamento para números
    if (coluna === "vl_aluguel" || coluna === "vl_vitalicio" || coluna === "nr_duracao_minutos") {
      novoValor = parseFloat(novoValor.replace(",", "."));
    }

    const colunasPermitidas = [
      "nm_titulo", "nm_categoria", "ds_descricao", "vl_aluguel", "vl_vitalicio",
      "dt_lancamento", "nm_idioma", "ds_generos", "nr_duracao_minutos",
      "ds_url_trailer_youtube", "ds_url_poster", "ds_file_id_telegram",
      "ds_url_bunny", "tp_fonte_prioritaria"
    ];

    try {
      if (!colunasPermitidas.includes(coluna)) throw new Error("Coluna inválida");

      await pool.query(`UPDATE "CONTEUDOS" SET "${coluna}" = $1 WHERE cd_conteudo = $2`, [novoValor, conteudoId]);

      catalogCache.data = null; // Limpa o cache para o site atualizar

      await ctx.reply(`✅ **Sucesso!**\n\nO campo foi atualizado no banco de dados. O Mini App já refletirá a mudança.`);
    } catch (err) {
      console.error(err);
      await ctx.reply("❌ Erro ao atualizar no banco. Verifique o formato do dado enviado.");
    }

    return ctx.scene.leave();
  }
);


const alterarBannerScene = new Scenes.WizardScene(
  "ALTERAR_BANNER_SCENE",
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    await ctx.reply("🖼️ **TROCAR BANNER**\n\nEnvie o **ID (UUID)** do filme/série que você quer trocar a imagem de capa:", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.conteudoId = ctx.message.text.trim();
    await ctx.reply("Ótimo! Agora envie o **Novo Link (URL)** da imagem que vai ficar no banner:");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const novaUrl = ctx.message.text.trim();
    const conteudoId = ctx.wizard.state.conteudoId;

    try {
      await pool.query('UPDATE "CONTEUDOS" SET ds_url_poster = $1 WHERE cd_conteudo = $2', [novaUrl, conteudoId]);

      catalogCache.data = null;

      await ctx.reply("✅ Banner atualizado com sucesso! O site já está com a imagem nova.");
    } catch (err) {
      console.error("❌ [ERRO BANNER]:", err.message);
      await ctx.reply("❌ Erro ao atualizar o banner. Verifique se o ID está correto no banco.");
    }
    return ctx.scene.leave();
  }
);

const alterarStartScene = new Scenes.WizardScene(
  "ALTERAR_START_SCENE",
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    await ctx.reply("📸 **TROCAR FOTO DO /START**\n\nMande a Foto direto aqui no chat (ou envie um link de imagem URL):", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  async (ctx) => {
    let valorParaSalvar = "";

    // Pega o Link ou o File_ID nativo do Telegram
    if (ctx.message && ctx.message.text) {
        valorParaSalvar = ctx.message.text.trim();
    } else if (ctx.message && ctx.message.photo) {
        // Pega a versão com maior qualidade da foto
        valorParaSalvar = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else {
        return; // Escudo: Ignora se não for foto nem texto
    }

    const loadingMsg = await ctx.reply("⏳ Salvando configuração no banco de dados...");

    try {
        // O "upsert" insere se não existir, ou atualiza se já existir!
        await pool.query(
            `INSERT INTO "CONFIGURACOES" (nome_config, valor_config) VALUES ($1, $2)
             ON CONFLICT (nome_config) DO UPDATE SET valor_config = EXCLUDED.valor_config`,
            ['FOTO_START', valorParaSalvar]
        );

        await ctx.reply("✅ **Sucesso!** A Imagem de Boas-Vindas foi atualizada no banco de dados.");
    } catch (err) {
        console.error("❌ Erro DB Config:", err.message);
        await ctx.reply("❌ Erro ao salvar no banco. Verifique se criou a tabela CONFIGURACOES corretamente.");
    } finally {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }
    return ctx.scene.leave();
  }
);

const editarCarrosselScene = new Scenes.WizardScene(
  "EDITAR_CARROSSEL_SCENE",
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    
    let atuais = "Nenhum";
    try {
        const { rows: config } = await pool.query('SELECT valor_config FROM "CONFIGURACOES" WHERE nome_config = $1 LIMIT 1', ["CARROSSEL_IDS"]);
        if (config && config.length > 0 && config[0].valor_config) atuais = config[0].valor_config;
    } catch (e) {}

    await ctx.reply(`🎡 **EDITAR CARROSSEL DO APP**\n\nIDs atuais no carrossel:\n\`${atuais}\`\n\nPara montar seu carrossel, **envie os IDs separados por vírgula**, na exata ordem que você deseja que eles apareçam (O 1º ID será o banner principal).\n\n*(Dica: Use /buscar Nome do Filme para pegar os IDs antes)*\n\nOu digite **CANCELAR** para sair:`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const texto = ctx.message.text.trim();

    if (texto.toUpperCase() === "CANCELAR") {
        await ctx.reply("❌ Operação cancelada.");
        return ctx.scene.leave();
    }

    // Limpa quebras de linha e espaços acidentais que a Mell possa enviar
    const idsLimpos = texto.split(",").map(id => id.replace(/\n/g, '').trim()).filter(id => id !== "").join(",");
    
    try {
        // 🚀 MÁGICA: Em vez de Upsert (que dá erro de constraint), checamos e atualizamos manualmente!
        const { rows: existe } = await pool.query('SELECT valor_config FROM "CONFIGURACOES" WHERE nome_config = $1 LIMIT 1', ["CARROSSEL_IDS"]);

        if (existe && existe.length > 0) {
            await pool.query('UPDATE "CONFIGURACOES" SET valor_config = $1 WHERE nome_config = $2', [idsLimpos, "CARROSSEL_IDS"]);
        } else {
            await pool.query('INSERT INTO "CONFIGURACOES" (nome_config, valor_config) VALUES ($1, $2)', ["CARROSSEL_IDS", idsLimpos]);
        }

        catalogCache.data = null; // Invalida o cache pra atualizar o app na mesma hora!
        
        await ctx.reply("✅ **Carrossel atualizado com sucesso!**\nAbra o aplicativo para ver a nova ordem.", { parse_mode: "Markdown" });
    } catch (e) {
        console.error("Erro ao salvar carrossel:", e);
        await ctx.reply("❌ Erro ao salvar configuração.");
    }
    return ctx.scene.leave();
  }
);

const alterarPrecoPlanoScene = new Scenes.WizardScene(
  "ALTERAR_PRECO_PLANO_SCENE",
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});


    const { rows: planos } = await pool.query('SELECT * FROM "PLANOS" ORDER BY vl_plano ASC');

    if (!planos || planos.length === 0) {
      await ctx.reply("❌ Nenhum plano encontrado no banco de dados.");
      return ctx.scene.leave();
    }

    let texto = "💲 **PROMOÇÕES E ASSINATURAS**\n\nAqui estão os planos atuais:\n\n";
    planos.forEach(p => {
      texto += `ID: \`${p.cd_plano}\`\nNome: ${p.nm_plano}\nPreço Atual: R$ ${p.vl_plano}\n\n`;
    });
    texto += "Copie e envie o **ID** do plano que você quer mudar o preço:";
    
    await ctx.reply(texto, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.planoId = ctx.message.text.trim();
    await ctx.reply("Qual vai ser o **Novo Preço**? (Ex: 19.90 ou 15.00)");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const novoPrecoStr = ctx.message.text.replace(",", "."); 
    const novoPreco = parseFloat(novoPrecoStr);
    const planoId = ctx.wizard.state.planoId;

    if (isNaN(novoPreco)) {
      await ctx.reply("❌ Preço inválido. Operação cancelada.");
      return ctx.scene.leave();
    }

    try {
      await pool.query('UPDATE "PLANOS" SET vl_plano = $1 WHERE cd_plano = $2', [novoPreco, planoId]);

      await ctx.reply(`✅ Preço atualizado para **R$ ${novoPreco.toFixed(2)}** com sucesso!\n\nAs próximas vendas e PIXs gerados já sairão com esse novo valor promocional. 🚀`, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("❌ [ERRO PRECO]:", err.message);
      await ctx.reply("❌ Erro ao atualizar o preço.");
    }
    return ctx.scene.leave();
  }
);

// =================================================================
// 🔍 FLUXO ADMIN: CONSULTAR TXID
// =================================================================
const consultarTxidScene = new Scenes.WizardScene(
  "CONSULTAR_TXID_SCENE",
  async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("🔍 **CONSULTA DE PIX (TXID)**\n\nEnvie o **TXID** da transação que você deseja rastrear:\n*(Ou digite CANCELAR para sair)*", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const txid = ctx.message.text.trim();

    if (txid.toUpperCase() === "CANCELAR") {
        await ctx.reply("❌ Consulta cancelada.");
        return ctx.scene.leave();
    }

    const loadingMsg = await ctx.reply("⌛ Buscando transação no banco de dados...");

    try {
        const { rows: vendas } = await pool.query(
            `SELECT v.cd_venda, v.nr_id_telegram, v.tp_compra, v.tp_status, v.ts_criacao, v.ds_txid,
                    c.nm_titulo AS "conteudoTitulo", p.nm_plano AS "planoNome"
             FROM "VENDAS" v
             LEFT JOIN "CONTEUDOS" c ON c.cd_conteudo = v.cd_conteudo
             LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
             WHERE v.ds_txid = $1`,
            [txid]
        );

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

        if (!vendas || vendas.length === 0) {
            await ctx.reply("❌ Nenhum registro encontrado com esse TXID.");
            return ctx.scene.leave();
        }

        let msg = `✅ **TRANSAÇÃO ENCONTRADA:**\n\n`;
        vendas.forEach(v => {
            const item = v.tp_compra === "ASSINATURA" ? `👑 ${v.planoNome}` : `🎬 ${v.conteudoTitulo}`;
            const dataCriacao = new Date(v.ts_criacao).toLocaleString('pt-BR');
            
            msg += `🧾 **TXID:** \`${v.ds_txid}\`\n`;
            // 🚀 Aqui o ID ganha o link clicável direto pro chat da pessoa!
            msg += `👤 **ID do Cliente:** \`${v.nr_id_telegram}\` ([🗣️ Abrir Chat](tg://user?id=${v.nr_id_telegram}))\n`;
            msg += `📦 **Item:** ${item}\n`;
            msg += `🚦 **Status:** ${v.tp_status}\n`;
            msg += `📅 **Data:** ${dataCriacao}\n`;
            msg += `🔑 **ID Sistema:** ${v.cd_venda}\n\n`;
        });

        msg += `*(Dica: Copie o ID do Cliente acima e use a opção "Gerenciar Cliente" no /admin caso precise liberar o acesso manualmente).*`;

        await ctx.reply(msg, { parse_mode: "Markdown" });

    } catch (err) {
        console.error("❌ Erro na consulta de TXID:", err);
        await ctx.reply("❌ Ocorreu um erro ao consultar o banco de dados.");
    }

    return ctx.scene.leave();
  }
);

const criarPlanoScene = new Scenes.WizardScene(
  "CRIAR_PLANO_SCENE",
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    ctx.wizard.state.plano = {};
    await ctx.reply("📦 **CRIAR NOVO PLANO**\n\nQual vai ser o **NOME** do plano? (Ex: Passe Mensal, VIP Doramas, Plano Ouro)");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    ctx.wizard.state.plano.nome = ctx.message.text.trim();
    
    await ctx.reply(`Qual **CATEGORIA** esse plano vai liberar?\n\n*(Dica: Digite exatamente a categoria que deseja liberar, ex: Dorama, Short, Filme. Ou digite **TODAS** para liberar o aplicativo inteiro)*`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    ctx.wizard.state.plano.categoria = ctx.message.text.trim();
    
    await ctx.reply("Qual o **PREÇO** do plano? (Ex: 19.90 ou 25.00)");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const preco = parseFloat(ctx.message.text.replace(",", "."));
    
    if (isNaN(preco)) {
       await ctx.reply("❌ Preço inválido. Operação cancelada.");
       return ctx.scene.leave();
    }
    
    ctx.wizard.state.plano.preco = preco;
    await ctx.reply("Qual a **VALIDADE** do plano em dias? (Ex: 30 para mensal, 365 para anual)");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const dias = parseInt(ctx.message.text.trim());
    const p = ctx.wizard.state.plano;

    if (isNaN(dias)) {
        await ctx.reply("❌ Validade inválida. Operação cancelada.");
        return ctx.scene.leave();
    }

    const loadingMsg = await ctx.reply("⏳ Criando plano no banco de dados...");

    try {
        await pool.query(
            `INSERT INTO "PLANOS" (nm_plano, nm_categoria, vl_plano, nr_dias_validade) VALUES ($1, $2, $3, $4)`,
            [p.nome, p.categoria, p.preco, dias]
        );

        await ctx.reply(`✅ **Plano Criado com Sucesso!**\n\n💎 Nome: ${p.nome}\n📂 Libera: ${p.categoria}\n💲 Preço: R$ ${p.preco.toFixed(2)}\n⏱ Validade: ${dias} dias\n\nEle já está aparecendo na aba PREMIUM do Mini App!`, { parse_mode: "Markdown" });
    } catch(e) {
        console.error("❌ [ERRO CRIAR PLANO]:", e.message);
        await ctx.reply("❌ Erro ao criar o plano no banco de dados.");
    } finally {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }
    
    return ctx.scene.leave();
  }
);

const editarNomeCategoriaPlanoScene = new Scenes.WizardScene(
  "EDITAR_NOME_CATEGORIA_PLANO_SCENE",
  
  // Passo 1: Listar Planos e Pedir ID
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    const { rows: planos } = await pool.query('SELECT * FROM "PLANOS" ORDER BY vl_plano ASC');

    if (!planos || planos.length === 0) {
      await ctx.reply("❌ Nenhum plano encontrado.");
      return ctx.scene.leave();
    }

    let texto = "🛠️ **EDITAR DEFINIÇÃO DE PLANO**\n\nAqui estão os planos atuais:\n\n";
    planos.forEach(p => {
      texto += `ID: \`${p.cd_plano}\`\nNome: ${p.nm_plano}\n📂 Libera: ${p.nm_categoria}\n\n`;
    });
    texto += "Copie e envie o **ID** do plano que você quer editar:";
    
    await ctx.reply(texto, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // Passo 2: Escolher o que editar
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const planoId = ctx.message.text.trim();
    ctx.wizard.state.planoId = planoId;
    
    await ctx.reply(`O que você deseja editar no plano ID \`${planoId}\`?`, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "✍️ Novo Nome", callback_data: "EDITAR_NM_PLANO" }],
                [{ text: "📂 Nova Categoria", callback_data: "EDITAR_NM_CATEGORIA" }],
                [{ text: "❌ Cancelar", callback_data: "CANCELAR_EDIT_PLANO" }]
            ]
        }
    });
    return ctx.wizard.next();
  },

  // Passo 3: Pedir o Novo Valor
  async (ctx) => {
    if (!ctx.callbackQuery) {
        await ctx.reply("⚠️ Ação inválida ou expirada. Envie /admin para começar de novo.");
        return ctx.scene.leave();
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (data === "CANCELAR_EDIT_PLANO") {
        await ctx.editMessageText("❌ Edição cancelada.");
        return ctx.scene.leave();
    }

    // Mapeia a coluna do banco baseada no botão clicado
    const coluna = data.replace("EDITAR_", "").toLowerCase();
    ctx.wizard.state.colunaDB = coluna.toUpperCase(); // Salva em maíusculo pra facilitar a leitura no próximo passo

    await ctx.editMessageText(`Digie o **NOVO** ${coluna === "nm_plano" ? "NOME" : "NOME DA CATEGORIA"} para esse plano:`, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // Passo 4: Salvar no Banco
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const novoValor = ctx.message.text.trim();
    const { planoId, colunaDB } = ctx.wizard.state;

    const loadingMsg = await ctx.reply("⏳ Atualizando banco de dados...");

    try {
        // Lógica de update dinâmico
        const updateObject = {};
        if(colunaDB === "NM_PLANO") updateObject.nm_plano = novoValor;
        if(colunaDB === "NM_CATEGORIA") updateObject.nm_categoria = novoValor;

        const colunas = Object.keys(updateObject);
        const setClauses = colunas.map((col, i) => `"${col}" = $${i + 1}`).join(", ");
        const valores = colunas.map(col => updateObject[col]);

        await pool.query(
            `UPDATE "PLANOS" SET ${setClauses} WHERE cd_plano = $${colunas.length + 1}`,
            [...valores, planoId]
        );

        await ctx.reply(`✅ **Sucesso!**\n\nO plano foi atualizado no banco. O Mini App já mostrará o novo nome/categoria na próxima vez que for aberto.`);
    } catch(err) {
        console.error("❌ ERRO EDITAR PLANO:", err.message);
        await ctx.reply("❌ Erro ao atualizar o plano no banco de dados. Verifique se o ID está correto.");
    } finally {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    }
    
    return ctx.scene.leave();
  }
);

// =================================================================
// 🗑️ FLUXO ADMIN: EXCLUIR PLANO DE ASSINATURA
// =================================================================
const excluirPlanoScene = new Scenes.WizardScene(
  "EXCLUIR_PLANO_SCENE",
  
  // Passo 1: Listar os planos e pedir o ID
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    
    const { rows: planos } = await pool.query('SELECT * FROM "PLANOS" ORDER BY vl_plano ASC');

    if (!planos || planos.length === 0) {
      await ctx.reply("❌ Nenhum plano encontrado no banco de dados.");
      return ctx.scene.leave();
    }

    let texto = "🗑️ **EXCLUIR PLANO DE ASSINATURA**\n\nAqui estão os planos atuais:\n\n";
    planos.forEach(p => {
      texto += `ID: \`${p.cd_plano}\`\nNome: ${p.nm_plano}\nPreço: R$ ${p.vl_plano}\n\n`;
    });
    texto += "Copie e envie o **ID** do plano que você deseja excluir definitivamente:\n*(Ou digite CANCELAR para sair)*";
    
    await ctx.reply(texto, { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },

  // Passo 2: Executar a exclusão no banco
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const input = ctx.message.text.trim();

    if (input.toUpperCase() === "CANCELAR") {
        await ctx.reply("❌ Operação cancelada.");
        return ctx.scene.leave();
    }

    const loadingMsg = await ctx.reply("⏳ Processando exclusão no banco de dados...");

    try {
      // Verifica se o plano existe para pegar o nome e dar um feedback amigável
      const { rows: planoRows } = await pool.query('SELECT nm_plano FROM "PLANOS" WHERE cd_plano = $1 LIMIT 1', [input]);
      const plano = planoRows[0];

      if (!plano) {
          await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
          await ctx.reply("❌ Plano não encontrado com esse ID. Operação cancelada.");
          return ctx.scene.leave();
      }

      // Executa o Delete
      await pool.query('DELETE FROM "PLANOS" WHERE cd_plano = $1', [input]);

      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      await ctx.reply(`✅ O plano **${plano.nm_plano}** foi excluído com sucesso do sistema!`, { parse_mode: "Markdown" });
      
    } catch (err) {
      console.error("❌ [ERRO EXCLUIR PLANO]:", err.message);
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      
      // Tratamento de erro de Chave Estrangeira (Foreign Key)
      if (err.message.includes('violates foreign key constraint')) {
          await ctx.reply("❌ **Erro:** Este plano não pode ser excluído porque existem **vendas ativas** vinculadas a ele. Mude os clientes de plano ou aguarde a expiração antes de excluir.");
      } else {
          await ctx.reply("❌ Ocorreu um erro interno ao tentar excluir o plano.");
      }
    }
    
    return ctx.scene.leave();
  }
);

const gerarLinkScene = new Scenes.WizardScene(
  "GERAR_LINK_SCENE",
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    await ctx.reply("🔗 **GERAR LINK DE DIVULGAÇÃO**\n\nEnvie o **ID (UUID)** do filme/série que você quer divulgar no canal:", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message?.text) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery().catch(()=>{});
        if (ctx.callbackQuery.data === "FECHAR_ADMIN") await ctx.deleteMessage().catch(()=>{});
      }
      await ctx.reply("❌ Operação cancelada.");
      return ctx.scene.leave();
    }

    const conteudoId = ctx.message.text.trim();
    
    try {
      // Pega as informações do bot (para descobrir o @ dele automaticamente)
      const botInfo = await ctx.telegram.getMe();
      
      // Monta o link mágico
      const linkDivulgacao = `https://t.me/${botInfo.username}?start=${conteudoId}`;

      await ctx.reply(`✅ **Link Gerado com Sucesso!**\n\nCopie o link abaixo e poste no seu grupo/canal junto com o banner do filme:\n\n\`${linkDivulgacao}\`\n\n*(Quando o cliente clicar, o bot vai abrir um botão exclusivo para esse filme!)*`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply("❌ Erro ao gerar o link.");
    }
    
    return ctx.scene.leave();
  }
); 


// =================================================================
// 📢 FLUXO ADMIN: TRANSMISSÃO GLOBAL (BROADCAST)
// =================================================================
const transmitirAvisoScene = new Scenes.WizardScene(
  "TRANSMITIR_AVISO_SCENE",
  
  async (ctx) => {
    await ctx.answerCbQuery().catch(()=>{});
    await ctx.reply("📢 **TRANSMISSÃO GLOBAL**\n\nEnvie a mensagem que você deseja disparar para **TODOS** os usuários que já usaram o bot:\n\n*(Ou digite CANCELAR para sair)*", { parse_mode: "Markdown" });
    return ctx.wizard.next();
  },
  
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const mensagem = ctx.message.text;

    if (mensagem.toUpperCase() === "CANCELAR") {
      await ctx.reply("❌ Transmissão cancelada.");
      return ctx.scene.leave();
    }

    const loadingMsg = await ctx.reply("⏳ Coletando lista de usuários no banco de dados...");

    try {
      // Coleta IDs únicos das tabelas SESSOES e VENDAS para garantir que vai para todo mundo
      const { rows: sessoes } = await pool.query('SELECT nr_id_telegram FROM "SESSOES"');
      const { rows: vendas } = await pool.query('SELECT nr_id_telegram FROM "VENDAS"');

      const idsUnicos = new Set();
      if (sessoes) sessoes.forEach(s => idsUnicos.add(s.nr_id_telegram));
      if (vendas) vendas.forEach(v => idsUnicos.add(v.nr_id_telegram));

      const usuarios = Array.from(idsUnicos);

      if (usuarios.length === 0) {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
        await ctx.reply("❌ Nenhum usuário encontrado no banco de dados.");
        return ctx.scene.leave();
      }

      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      await ctx.reply(`🚀 Iniciando disparo para **${usuarios.length}** usuários.\nIsso pode levar alguns minutos...`, { parse_mode: "Markdown" });

      let enviados = 0;
      let falhas = 0;

      // Função de delay para respeitar o limite do Telegram (30 mensagens por segundo)
      const delay = (ms) => new Promise(res => setTimeout(res, ms));

      for (const userId of usuarios) {
        try {
          // Tenta enviar a mensagem para o usuário
          await bot.telegram.sendMessage(userId, mensagem, { parse_mode: "Markdown" });
          enviados++;
        } catch (e) {
          // Se cair aqui, o usuário bloqueou o bot ou excluiu a conta
          falhas++;
        }
        await delay(50); // Aguarda 50ms entre cada envio
      }

      await ctx.reply(`✅ **Transmissão Concluída!**\n\n📤 Enviados com sucesso: ${enviados}\n❌ Falhas (Bot bloqueado/apagado): ${falhas}`, { parse_mode: "Markdown" });

    } catch (err) {
      console.error("❌ [ERRO TRANSMISSÃO]:", err.message);
      await ctx.reply("❌ Ocorreu um erro ao processar a transmissão.");
    }

    return ctx.scene.leave();
  }
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rota do webhook do Telegram — substitui bot.launch() (long polling)
app.use(bot.webhookCallback(BOT_WEBHOOK_PATH));

app.use(express.static("public", {
  setHeaders: function (res, path) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
}));


app.use(async (req, res, next) => {
  
  const userId = req.query.userId || req.body?.nr_id_telegram; 
  
  if (userId && userId !== "0" && userId !== "undefined") {
    const { rows: banRows } = await pool.query('SELECT * FROM "BANS" WHERE nr_id_telegram = $1 LIMIT 1', [userId]);
    const ban = banRows[0];
    if (ban) {
      console.log(`🚫 [BLOCK] Usuário banido tentou acessar: ${userId}`);
      return res.status(403).json({ error: "Sua conta foi suspensa." });
    }
  }
  next();
});


const stage = new Scenes.Stage([
  adicionarDramaScene, 
  gerenciarClienteScene, 
  excluirConteudoScene, 
  alterarBannerScene, 
  alterarPrecoPlanoScene, 
  gerarLinkScene,
  atualizarFilmeScene,
  alterarStartScene,
  criarPlanoScene,
  editarNomeCategoriaPlanoScene,
  adicionarEpisodioScene,
  editarCarrosselScene,
  consultarTxidScene,
  excluirPlanoScene,
  transmitirAvisoScene
]);
// =================================================================
// SISTEMA DE UPSELL INTELIGENTE - HELPER & SESSIONS
// =================================================================
async function verificarAssinaturaAtiva(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT cd_venda FROM "VENDAS"
       WHERE nr_id_telegram = $1 AND tp_compra = $2 AND tp_status = $3 AND ts_expiracao > $4
       LIMIT 1`,
      [userId, "ASSINATURA", "APROVADA", new Date().toISOString()]
    );
    return rows.length > 0;
  } catch (err) {
    console.error("❌ Erro ao verificar assinatura ativa:", err.message);
    return false;
  }
}

// =================================================================
// 🔔 AVISO DE NOVO EPISÓDIO
// Avisa quem já começou a assistir (tem histórico) ou comprou/alugou
// o título — evita spam pra quem nunca abriu esse conteúdo.
// =================================================================
async function notificarNovoEpisodio(serieId, numEpisodio, tituloEpisodio) {
  try {
    const { rows: serieRows } = await pool.query('SELECT nm_titulo FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1', [serieId]);
    const tituloSerie = serieRows[0]?.nm_titulo || "Sua série";

    const { rows: interessados } = await pool.query(
      `SELECT DISTINCT nr_id_telegram FROM (
         SELECT nr_id_telegram FROM "HISTORICO" WHERE cd_conteudo = $1
         UNION
         SELECT nr_id_telegram FROM "VENDAS" WHERE cd_conteudo = $1 AND tp_status = 'APROVADA'
       ) AS quem_ja_assiste`,
      [serieId]
    );

    if (!interessados || interessados.length === 0) return;

    console.log(`🔔 [EPISÓDIO NOVO] Avisando ${interessados.length} usuário(s) sobre "${tituloSerie}" EP ${numEpisodio}...`);

    const delay = (ms) => new Promise((res) => setTimeout(res, ms));
    const webAppUrl = `${process.env.WEBAPP_URL}?movie=${serieId}`;

    for (const u of interessados) {
      try {
        await bot.telegram.sendMessage(
          u.nr_id_telegram,
          `🔔 **Novo episódio no ar!**\n\n📺 *${tituloSerie}*\n🎬 EP ${numEpisodio}: ${tituloEpisodio}\n\nJá está liberado no app! 🍿`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "▶️ ASSISTIR AGORA", web_app: { url: webAppUrl } }]] }
          }
        );
      } catch (e) {
        // Usuário bloqueou o bot ou não pode receber mensagem — segue o baile
      }
      await delay(100); // Respeita o limite de ~30 msgs/s do Telegram
    }
  } catch (err) {
    console.error("❌ [EPISÓDIO NOVO] Erro ao notificar:", err.message);
  }
}

const customSessions = {};

bot.use((ctx, next) => {
  if (ctx.from && ctx.from.id) {
    const key = `${ctx.from.id}:${ctx.from.id}`;
    if (!customSessions[key]) {
      customSessions[key] = {};
    }
    ctx.session = customSessions[key];
  } else {
    ctx.session = {};
  }
  return next();
});
bot.use(stage.middleware());

// =================================================================
// 3. ROTAS DA API (PARA O MINI APP)
// =================================================================

// Listar Catálogo (100% EM TEMPO REAL E BLINDADO CONTRA CACHE)
app.get("/api/catalog", async (req, res) => {
  // 🛡️ MURALHA ANTI-CACHE: Força iPhones, Androids e o Telegram a buscarem dados frescos sempre
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  try {
    console.log("🔄 [API] Calculando Ranking Inteligente MENSAL em Tempo Real...");

    // 🚀 LÓGICA MENSAL: Descobre o primeiro segundo do mês atual
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);
    const isoInicioMes = inicioMes.toISOString();

    // 1. Busca todos os filmes do catálogo
    const { rows: conteudos } = await pool.query('SELECT * FROM "CONTEUDOS"');

    // 2. BUSCA VENDAS DO MÊS JÁ PROCESSADAS PELA VIEW (Sem limite de 1000 linhas)
    const { rows: vendasMastigadas } = await pool.query('SELECT cd_conteudo, total_vendas FROM vw_ranking_mensal');

    // 3. Monta o dicionário de vendas
    const contagemVendas = {};
    if (vendasMastigadas) {
      vendasMastigadas.forEach((v) => {
        contagemVendas[v.cd_conteudo] = v.total_vendas;
      });
    }

    // 4. Injeta o total de vendas em cada filme
    let catalogoInteligente = conteudos.map((filme) => ({
      ...filme,
      total_vendas: contagemVendas[filme.cd_conteudo] || 0,
    }));

    // 5. CALCULA O SCORE E DISTRIBUI O TOP 12 (Ordem EXATAMENTE igual ao Bot)
    catalogoInteligente.sort((a, b) => {
        if (b.total_vendas !== a.total_vendas) {
            return b.total_vendas - a.total_vendas; 
        }
        const tituloA = a.nm_titulo || "";
        const tituloB = b.nm_titulo || "";
        return tituloA.localeCompare(tituloB);
    });

    // Dá as medalhas do Top 12 baseado na ordem exata de Vendas + Alfabeto
    catalogoInteligente = catalogoInteligente.map((filme, index) => {
      return { ...filme, rank_top: index < 12 ? index + 1 : 0 };
    });

    // =========================================================
    // 🚀 6. CARROSSEL MESCLADO E ORGANIZAÇÃO FINAL
    // =========================================================
    let idsManuais = [];
    try {
        const { rows: configCarrossel } = await pool.query(
            'SELECT valor_config FROM "CONFIGURACOES" WHERE nome_config = $1 LIMIT 1',
            ["CARROSSEL_IDS"]
        );

        if (configCarrossel && configCarrossel.length > 0 && configCarrossel[0].valor_config) {
            idsManuais = configCarrossel[0].valor_config.split(",").map(id => id.trim().toLowerCase()).filter(id => id !== "");
        }
    } catch (e) {}

    // Monta a lista VIP das 5 posições do Carrossel
    const idsCarrosselFinal = [...idsManuais]; 
    for (const filme of catalogoInteligente) {
        if (idsCarrosselFinal.length >= 5) break; 
        const idFilme = String(filme.cd_conteudo).toLowerCase();
        if (!idsCarrosselFinal.includes(idFilme)) idsCarrosselFinal.push(idFilme);
    }

    // Marca quem é destaque do carrossel
    catalogoInteligente = catalogoInteligente.map(filme => {
        return { 
            ...filme, 
            sn_destaque: idsCarrosselFinal.includes(String(filme.cd_conteudo).toLowerCase()) 
        };
    });

    // Reordena a lista completa do site (Garante o carrossel no topo, mas respeita as Vendas)
    catalogoInteligente.sort((a, b) => {
        const indexA = idsManuais.indexOf(String(a.cd_conteudo).toLowerCase());
        const indexB = idsManuais.indexOf(String(b.cd_conteudo).toLowerCase());

        if (indexA !== -1 && indexB !== -1) return indexA - indexB; 
        if (indexA !== -1) return -1; 
        if (indexB !== -1) return 1;  
        
        if (b.total_vendas !== a.total_vendas) return b.total_vendas - a.total_vendas;
        return (a.nm_titulo || "").localeCompare(b.nm_titulo || "");
    });

    // Retorna direto os dados frescos calculados do banco na hora
    res.json(catalogoInteligente);

  } catch (error) {
    console.error("❌ [ERRO CATALOG]:", error.message);
    res.status(500).json({ error: "Erro ao carregar catálogo." });
  }
});

app.get("/api/user-status", async (req, res) => {
  const { userId } = req.query;
  if (!userId || userId === "0" || userId === "undefined") return res.json({ isVip: false });

  try {
    const agora = new Date().toISOString();
    // Busca todas as vendas ativas que são de Planos (Assinaturas)
    const { rows: vendas } = await pool.query(
      `SELECT v.ts_expiracao, p.nm_categoria AS "planoCategoria", p.nm_plano AS "planoNome"
       FROM "VENDAS" v
       LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
       WHERE v.nr_id_telegram = $1 AND v.tp_status = $2 AND v.ts_expiracao > $3
       ORDER BY v.ts_expiracao DESC`,
      [userId, "APROVADA", agora]
    );

    if (!vendas || vendas.length === 0) return res.json({ isVip: false });

    // Pega a primeira assinatura válida que encontrar
    const vipSale = vendas.find(v => v.planoNome);

    if (vipSale) {
      return res.json({
        isVip: true,
        plano: vipSale.planoNome,
		categoria: vipSale.planoCategoria,
        expira: vipSale.ts_expiracao
      });
    }
    return res.json({ isVip: false });
  } catch (e) {
    return res.json({ isVip: false });
  }
});

// Listar Minha Lista (Agora com Suporte a Sinônimos e Múltiplas Categorias)
app.get("/api/my-contents", async (req, res) => {
  const { userId } = req.query;

  if (!userId || userId === "0" || userId === "undefined") {
    return res.json([]);
  }

  try {
    const agora = new Date().toISOString();

    // 1. Busca Vendas
    const { rows: vendas } = await pool.query(
      `SELECT v.cd_conteudo, v.cd_plano, v.tp_status, v.ts_expiracao, p.nm_categoria AS "planoCategoria"
       FROM "VENDAS" v
       LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
       WHERE v.nr_id_telegram = $1 AND v.tp_status = $2 AND v.ts_expiracao > $3`,
      [userId, "APROVADA", agora]
    );

    if (!vendas || vendas.length === 0) return res.json([]);

    const idsVideosAvulsos = vendas.filter((v) => v.cd_conteudo).map((v) => v.cd_conteudo);
    const categoriasAssinadas = vendas.filter((v) => v.cd_plano && v.planoCategoria).map((v) => v.planoCategoria);

    const normCat = (s) => (s || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const categoriasNorm = categoriasAssinadas.map(c => normCat(c));

    // 2. Busca o Catálogo
    const { rows: listaFinal } = await pool.query('SELECT * FROM "CONTEUDOS" ORDER BY ts_criacao DESC');

    if (categoriasNorm.includes("todas")) return res.json(listaFinal); // VIP TUDO

    // 3. O Filtro Mágico com Sinônimos
    const listaSegura = listaFinal.filter(item => {
      if (idsVideosAvulsos.includes(item.cd_conteudo)) return true;
      if (!item.nm_categoria) return false;
      
      const catItem = normCat(item.nm_categoria);
      
      return categoriasNorm.some(catPlano => {
          // 🚀 BLINDAGEM: Aceita qualquer variação da palavra!
          if (catPlano === 'todas' || catPlano === 'tudo' || catPlano === 'todos') return true;
          
          // Aliases Automáticos
          if (catPlano.includes('asiatica') && catItem.includes('dorama')) return true;
          if (catPlano.includes('dorama') && catItem.includes('asiatica')) return true;
          if (catPlano.includes('americano') && catItem.includes('americana')) return true;
          if (catPlano.includes('americana') && catItem.includes('americano')) return true;
          
          // Separação por Vírgulas
          const cats = catPlano.split(',').map(c => c.trim());
          return cats.some(c => catItem === c);
      });
    });

    res.json(listaSegura);
  } catch (error) {
    console.error("❌ [ERRO MY-LIST]:", error.message);
    res.status(500).json({ error: "Erro ao processar sua lista." });
  }
});

// Listar Planos de Assinatura
app.get("/api/plans", async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM "PLANOS" ORDER BY vl_plano ASC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Erro ao carregar planos" });
  }
});

// Create-Order (Híbrido) Efí Bank
app.post("/api/create-order", async (req, res) => {
  const { id_origem, nr_id_telegram, modalidade } = req.body;

  try {
    let valor, titulo, insertData;

    if (modalidade === "ASSINATURA") {
      const { rows: planoRows } = await pool.query('SELECT * FROM "PLANOS" WHERE cd_plano = $1 LIMIT 1', [id_origem]);
      const plano = planoRows[0];
      if (!plano) return res.status(404).json({ error: "Plano não encontrado." });

      valor = plano.vl_plano;
      titulo = `Assinatura: ${plano.nm_plano}`;
      insertData = { cd_plano: id_origem, nr_id_telegram, tp_compra: "ASSINATURA" };
    } else {
      const { rows: itemRows } = await pool.query('SELECT * FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1', [id_origem]);
      const item = itemRows[0];
      if (!item) return res.status(404).json({ error: "Conteúdo não encontrado." });

      valor = modalidade === "ALUGUEL" ? item.vl_aluguel : item.vl_vitalicio;
      titulo = `${item.nm_titulo} (${modalidade})`;
      insertData = { cd_conteudo: id_origem, nr_id_telegram, tp_compra: modalidade };
    }

    // 🎯 1. CHAMA A EFÍ AQUI
    const pix = await efiService.gerarPix(valor, titulo, nr_id_telegram, id_origem, modalidade);

    // 🎯 2. SALVA O TXID NA VENDA (Protegido com logs claros)
    const vendaData = { ...insertData, tp_status: "PENDENTE", ds_txid: pix.txid };
    const vendaColunas = Object.keys(vendaData);
    const vendaPlaceholders = vendaColunas.map((_, i) => `$${i + 1}`).join(", ");
    const vendaValores = vendaColunas.map(col => vendaData[col]);

    try {
        await pool.query(
            `INSERT INTO "VENDAS" (${vendaColunas.join(", ")}) VALUES (${vendaPlaceholders})`,
            vendaValores
        );
    } catch (dbError) {
        console.error("❌ [ERRO DB]:", dbError.message);
        throw new Error("Erro ao salvar a venda no banco de dados.");
    }

    // 🎯 3. LIMPEZA DE STRING SEGURA (Evita crash de undefined/split)
    let base64Code = pix.qrCode || "";
    if (base64Code.includes(",")) {
        base64Code = base64Code.split(",")[1];
    }

    // 🎯 4. DEVOLVE PRA TELA DO CLIENTE
    res.json({
      success: true,
      qrCodeBase64: base64Code,
      qrCode: pix.copyPaste 
    });

  } catch (error) {
    console.error("❌ [ERRO CREATE-ORDER]:", error.message);
    res.status(500).json({ error: "Erro interno ao gerar o pagamento. Olhe os logs do PM2." });
  }
});

// Rota de Checagem (Com Auto-Cura pela Efí)
app.get("/api/check-payment", async (req, res) => {
  const { userId, contentId, planId } = req.query;
  
  try {
    // 1. Primeiro checa se já está APROVADA (Rápido)
    const aprovadaParams = [userId, "APROVADA", new Date().toISOString()];
    let aprovadaWhere = `nr_id_telegram = $1 AND tp_status = $2 AND ts_expiracao > $3`;
    if (contentId) { aprovadaParams.push(contentId); aprovadaWhere += ` AND cd_conteudo = $${aprovadaParams.length}`; }
    if (planId) { aprovadaParams.push(planId); aprovadaWhere += ` AND cd_plano = $${aprovadaParams.length}`; }

    const { rows: aprovadas } = await pool.query(
      `SELECT tp_status FROM "VENDAS" WHERE ${aprovadaWhere}`,
      aprovadaParams
    );
    if (aprovadas && aprovadas.length > 0) {
      return res.json({ approved: true });
    }

    // 2. Se NÃO está aprovada, busca a venda PENDENTE para perguntar pra Efí (A Mágica da Redundância)
    const pendenteParams = [userId, "PENDENTE"];
    let pendenteWhere = `v.nr_id_telegram = $1 AND v.tp_status = $2`;
    if (contentId) { pendenteParams.push(contentId); pendenteWhere += ` AND v.cd_conteudo = $${pendenteParams.length}`; }
    if (planId) { pendenteParams.push(planId); pendenteWhere += ` AND v.cd_plano = $${pendenteParams.length}`; }

    const { rows: pendentes } = await pool.query(
      `SELECT v.*, p.nr_dias_validade AS "planoDiasValidade"
       FROM "VENDAS" v
       LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
       WHERE ${pendenteWhere}
       ORDER BY v.ts_criacao DESC`,
      pendenteParams
    );

    if (pendentes && pendentes.length > 0) {
      const venda = pendentes[0];
      
      // Se a venda tem um TXID, vamos perguntar direto pro banco Efí!
      if (venda.ds_txid) {
        const infoPix = await efiService.consultarPix(venda.ds_txid);
        
        // Se a Efí disser que foi CONCLUÍDA (dinheiro na conta), forçamos a aprovação!
        if (infoPix && infoPix.status === "CONCLUIDA") {
           console.log(`🛡️ [REDUNDÂNCIA] Webhook falhou, mas o Polling salvou a venda! TXID: ${venda.ds_txid}`);
           
           const type = venda.tp_compra;
           let diasValidade = type === "ALUGUEL" ? 7 : type === "VITALICIO" ? 18250 : 30;
           if (type === "ASSINATURA" && venda.planoDiasValidade) {
               diasValidade = venda.planoDiasValidade;
           }

           const ts_expiracao = new Date();
           ts_expiracao.setDate(ts_expiracao.getDate() + diasValidade);

           // Atualiza o banco pra APROVADA
           await pool.query(
               'UPDATE "VENDAS" SET tp_status = $1, ts_expiracao = $2 WHERE ds_txid = $3',
               ["APROVADA", ts_expiracao.toISOString(), venda.ds_txid]
           );

           catalogCache.data = null; // Ranking precisa refletir a nova venda

           // Manda a mensagem pro cliente
           await bot.telegram.sendMessage(venda.nr_id_telegram, "🎉 **PAGAMENTO CONFIRMADO!**\n\nSeu acesso Premium foi liberado. Aproveite! 🍿", { parse_mode: "Markdown" }).catch(()=>{});

           return res.json({ approved: true });
        }
      }
    }

    // Se chegou aqui, é porque não pagou ainda
    res.json({ approved: false });
  } catch (error) {
    console.error("Erro no check-payment:", error.message);
    res.json({ approved: false });
  }
});

// Entrega de Vídeo Via Bot (Mensagem Direta)
app.post("/api/watch-video", async (req, res) => {
  const { cd_conteudo, nr_id_telegram, episodioId } = req.body;

  try {
    const { rows: filmeRows } = await pool.query('SELECT * FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1', [cd_conteudo]);
    const filme = filmeRows[0];

    const { rows: acessos } = await pool.query(
      `SELECT v.*, p.nm_categoria AS "planoCategoria"
       FROM "VENDAS" v
       LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
       WHERE v.nr_id_telegram = $1 AND v.tp_status = $2 AND v.ts_expiracao > $3`,
      [nr_id_telegram, "APROVADA", new Date().toISOString()]
    );

    // 🚀 INTELIGÊNCIA DE SINÔNIMOS PARA SEGURANÇA
    const normCat = (s) => (s || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const catConteudo = normCat(filme?.nm_categoria);

    const temDireito = acessos.some(a => {
        if (a.cd_conteudo === cd_conteudo) return true;
        if (!a.planoCategoria) return false;

        const catPlano = normCat(a.planoCategoria);
        if (catPlano === 'todas' || catPlano === 'tudo' || catPlano === 'todos') return true;
        
        if (catPlano.includes('asiatica') && catConteudo.includes('dorama')) return true;
        if (catPlano.includes('dorama') && catConteudo.includes('asiatica')) return true;
        if (catPlano.includes('americano') && catConteudo.includes('americana')) return true;
        if (catPlano.includes('americana') && catConteudo.includes('americano')) return true;

        const catsDoPlano = catPlano.split(',').map(c => c.trim());
        return catsDoPlano.some(c => catConteudo === c);
    });

    if (!temDireito) return res.status(403).json({ error: "Acesso expirado ou Categoria não autorizada no seu Plano." });

    let fileIdParaEnviar = "";
    let legenda = "";

    // 🚀 MUDANÇA: Substituição de ** por <b> para Parse HTML (Blindado contra caracteres estranhos)
    if (episodioId) {
        const { rows: epRows } = await pool.query('SELECT * FROM "EPISODIOS" WHERE cd_episodio = $1 LIMIT 1', [episodioId]);
        const ep = epRows[0];
        if (!ep || !ep.ds_file_id_telegram) return res.status(404).json({ error: "O arquivo deste episódio sumiu do banco de dados." });

        fileIdParaEnviar = ep.ds_file_id_telegram;
        legenda = `📺 <b>${filme.nm_titulo}</b>\n🎬 EP ${ep.nr_episodio}: ${ep.nm_titulo}\n\n🍿 Conteúdo Protegido Melreels.`;
    } else {
        fileIdParaEnviar = filme.ds_file_id_telegram;
        legenda = `🎬 <b>${filme.nm_titulo}</b>\n\n🍿 Conteúdo Protegido Melreels.`;
    }

    // DISPARA A MENSAGEM COM PROTEÇÃO TOTAL
    await bot.telegram.sendVideo(nr_id_telegram, fileIdParaEnviar, {
      caption: legenda,
      parse_mode: "HTML", // 🚀 MUDANÇA SALVA-VIDAS
      protect_content: true,
    });

    const viewsAtuais = filme.nr_views || 0;
    await pool.query('UPDATE "CONTEUDOS" SET nr_views = $1 WHERE cd_conteudo = $2', [viewsAtuais + 1, cd_conteudo]);
    catalogCache.data = null;

    res.json({ success: true });

  } catch (error) {
    console.error("❌ [ERRO WATCH-VIDEO]:", error.message);
    let msgErro = "Erro interno no servidor ao tentar enviar o vídeo.";
    
    // 🚀 LÓGICA NINJA: Descobre por que o Telegram barrou o envio
    if (error.message.includes("blocked")) {
        msgErro = "Você bloqueou o bot ou apagou o chat! Por favor, feche o app, mande um /start pro bot e tente de novo.";
    } else if (error.message.includes("wrong file identifier")) {
        msgErro = "O vídeo deste filme/série está quebrado no servidor (ID inválido). Avise o suporte.";
    }
    
    res.status(500).json({ error: msgErro });
  }
});

// Streaming de Arquivo Remoto (Túnel API Telegram)
app.get("/api/stream-video", async (req, res) => {
  const { cd_conteudo, userId } = req.query;

  try {
    const { rows: acessoRows } = await pool.query(
      `SELECT tp_status FROM "VENDAS"
       WHERE nr_id_telegram = $1 AND cd_conteudo = $2 AND tp_status = $3 AND ts_expiracao > $4
       LIMIT 1`,
      [userId, cd_conteudo, "APROVADA", new Date().toISOString()]
    );
    if (!acessoRows[0]) return res.status(403).send("Acesso negado.");

    const { rows: itemRows } = await pool.query(
      'SELECT ds_file_id_telegram FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1',
      [cd_conteudo]
    );
    const item = itemRows[0];

    const fileInfo = await bot.telegram.getFile(item.ds_file_id_telegram);
    // Nota: A API padrão do Telegram limita downloads de bot a 20MB.
    const telegramUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;

    const response = await axios({
      method: "get",
      url: telegramUrl,
      responseType: "stream",
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", fileInfo.file_size);
    response.data.pipe(res);
  } catch (error) {
    console.error("❌ [ERRO STREAM TUNNEL]:", error.message);
    res.status(500).send("Erro ao carregar vídeo da nuvem.");
  }
});

// Streaming de Arquivo "Local" (Redireciona para o HD exposto via Cloudflare Tunnel)
app.get("/api/video/:filename", async (req, res) => {
  const { filename } = req.params;
  const { userId } = req.query; // Para futura validação rígida

  // Bloqueio básico se tentar acessar a URL diretamente pelo navegador sem estar logado no app
  if (!userId || userId === "undefined") {
    return res
      .status(403)
      .send("Forbidden. Acesso restrito ao Mini App Melreels.");
  }

  const videoUrl = await resolveVideoUrl(filename);

  if (!videoUrl) {
    console.error(`❌ [STREAM] Arquivo não encontrado em nenhum armazenamento: ${filename}`);
    return res
      .status(404)
      .send("Vídeo não encontrado no servidor de armazenamento.");
  }

  res.redirect(302, videoUrl);
});


// =================================================================
// 🧠 ROTEADOR INTELIGENTE DE STREAMING (LOCAL / BUNNY / TELEGRAM)
// =================================================================
app.get("/api/smart-stream", async (req, res) => {
  const { cd_conteudo, userId, episodioId } = req.query;

  try {
    // 0. Bloqueio de acesso anônimo
    if (!userId || userId === "0" || userId === "undefined") {
        console.log(`🚫 [ROTEADOR] Acesso anônimo bloqueado.`);
        return res.status(403).send("Acesso restrito ao Mini App.");
    }

    // 1. MURALHA DE SEGURANÇA SÊNIOR (🚀 A linha que tinha sumido voltou aqui!)
    const { rows: acessos } = await pool.query(
      `SELECT v.cd_conteudo, p.nm_categoria AS "planoCategoria"
       FROM "VENDAS" v
       LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
       WHERE v.nr_id_telegram = $1 AND v.tp_status = $2 AND v.ts_expiracao > $3`,
      [userId, "APROVADA", new Date().toISOString()]
    );

    // Puxa a categoria do conteúdo para cruzar com o Plano VIP
    const { rows: conteudoCheckRows } = await pool.query(
      'SELECT nm_categoria, tp_fonte_prioritaria FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1',
      [cd_conteudo]
    );
    const conteudoCheck = conteudoCheckRows[0];

    if (!acessos || acessos.length === 0) {
        console.log(`🚫 [ROTEADOR] Usuário ${userId} não possui vendas ativas.`);
        return res.status(403).send("Acesso negado ou expirado.");
    }

    // 🚀 A MÁGICA DE VERIFICAÇÃO COM SINÔNIMOS
    const normCat = (s) => (s || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const catConteudo = normCat(conteudoCheck?.nm_categoria);
    
    const temDireito = acessos.some(a => {
        if (a.cd_conteudo === cd_conteudo) return true;
        if (!a.planoCategoria) return false;

        const catPlano = normCat(a.planoCategoria);
        // 🚀 BLINDAGEM: Aceita qualquer variação
        if (catPlano === 'todas' || catPlano === 'tudo' || catPlano === 'todos') return true;
        
        if (catPlano.includes('asiatica') && catConteudo.includes('dorama')) return true;
        if (catPlano.includes('dorama') && catConteudo.includes('asiatica')) return true;
        if (catPlano.includes('americano') && catConteudo.includes('americana')) return true;
        if (catPlano.includes('americana') && catConteudo.includes('americano')) return true;

        const catsDoPlano = catPlano.split(',').map(c => c.trim());
        return catsDoPlano.some(c => catConteudo === c);
    });

    if (!temDireito) {
        console.log(`🚫 [ROTEADOR] Usuário ${userId} tentou acessar conteúdo sem permissão.`);
        return res.status(403).send("Conteúdo não autorizado no seu plano.");
    }

    console.log(`✅ [ROTEADOR] Acesso Autorizado para ID ${userId}. Preparando vídeo...`);

    // 2. BUSCA OS DADOS DO VÍDEO (Filme ou Série)
    let videoData = null;
    let fonte = 'LOCAL'; // Padrão de segurança máximo

    if (episodioId && episodioId !== "undefined") {
        const { rows: epRows } = await pool.query('SELECT * FROM "EPISODIOS" WHERE cd_episodio = $1 LIMIT 1', [episodioId]);
        videoData = epRows[0];
        fonte = conteudoCheck?.tp_fonte_prioritaria || 'LOCAL';
    } else {
        const { rows: filmeRows } = await pool.query('SELECT * FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1', [cd_conteudo]);
        const filme = filmeRows[0];
        videoData = filme;
        fonte = filme?.tp_fonte_prioritaria || 'LOCAL';
    }

    if (!videoData) {
        console.log(`❌ [ROTEADOR] Vídeo não encontrado no Banco de Dados.`);
        return res.status(404).send("Vídeo não encontrado.");
    }

    // =========================================================
    // 3. SISTEMA DE CASCATA (WATERFALL) - LOCAL → BUNNY → TELEGRAM
    // A ordem é definida pela prioridade configurada no banco,
    // mas o fallback é automático se a fonte principal falhar.
    // =========================================================
    const ordemFontes = {
        'LOCAL':    ['LOCAL', 'BUNNY', 'TELEGRAM'],
        'BUNNY':    ['BUNNY', 'LOCAL', 'TELEGRAM'],
        'TELEGRAM': ['TELEGRAM', 'BUNNY', 'LOCAL'],
    };
    const cascata = ordemFontes[fonte] || ['LOCAL', 'BUNNY', 'TELEGRAM'];
    console.log(`🔀 [CASCATA] Prioridade: ${fonte} | Ordem: ${cascata.join(' → ')}`);

    for (const tentativa of cascata) {

        if (tentativa === 'LOCAL') {
            const filename = videoData.ds_file_id_telegram;
            if (!filename) continue;
            // Arquivo local tem extensão de vídeo; Telegram ID é string longa sem ponto
            const ehArquivoLocal = /\.(mp4|mkv|avi|mov|webm)$/i.test(filename);
            if (!ehArquivoLocal) continue;

            const videoUrl = await resolveVideoUrl(filename);
            if (!videoUrl) {
                console.log(`⚠️ [CASCATA LOCAL] "${filename}" não encontrado em nenhum armazenamento. Tentando próxima fonte...`);
                continue;
            }

            console.log(`💻 [CASCATA LOCAL] Redirecionando "${filename}" para o HD via túnel.`);
            return res.redirect(302, videoUrl);
        }

        if (tentativa === 'BUNNY') {
            if (!videoData.ds_url_bunny) {
                console.log(`⚠️ [CASCATA BUNNY] URL não cadastrada. Tentando próxima fonte...`);
                continue;
            }
            console.log(`🐇 [CASCATA BUNNY] Redirecionando para CDN Bunny.net...`);
            return res.redirect(302, videoData.ds_url_bunny);
        }

        if (tentativa === 'TELEGRAM') {
            const fileId = videoData.ds_file_id_telegram;
            if (!fileId) { console.log(`⚠️ [CASCATA TELEGRAM] file_id não cadastrado.`); continue; }
            // Telegram file_id: string longa (60+ chars) sem extensão
            if (fileId.length <= 45 || fileId.includes('.')) {
                console.log(`⚠️ [CASCATA TELEGRAM] "${fileId.substring(0,15)}..." não é um file_id válido. Pulando...`);
                continue;
            }
            console.log(`✈️ [CASCATA TELEGRAM] Criando túnel com a API do Telegram...`);
            const fileInfo = await bot.telegram.getFile(fileId);
            const telegramUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
            const response = await axios({ method: "get", url: telegramUrl, responseType: "stream" });
            res.setHeader("Content-Type", "video/mp4");
            if (fileInfo.file_size) res.setHeader("Content-Length", fileInfo.file_size);
            return response.data.pipe(res);
        }
    }

    console.log(`❌ [CASCATA] Todas as fontes falharam para o conteúdo ${cd_conteudo}.`);
    res.status(404).send("Nenhuma fonte de vídeo disponível para este conteúdo.");

  } catch (error) {
    console.error("❌ [ERRO ROTEADOR]:", error.message);
    res.status(500).send("Erro interno ao rotear o vídeo.");
  }
});

app.post("/api/heartbeat", async (req, res) => {
    const { nr_id_telegram, cd_conteudo, dispositivo } = req.body;
    
    // 🛡️ Filtro Sênior: Se o cd_conteudo não for um UUID válido (36 caracteres), manda NULL
    // Isso evita o erro de "invalid input syntax for type uuid" que trava o app
    const validContentId = (cd_conteudo && cd_conteudo.length === 36) ? cd_conteudo : null;

    try {
        // 🚀 O UPSERT usa a sua constraint 'nr_id_telegram' para saber
        // que deve ATUALIZAR a linha existente em vez de criar uma nova.
        try {
            await pool.query(
                `INSERT INTO "SESSOES" (nr_id_telegram, cd_conteudo, status, dispositivo, ultima_atividade)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (nr_id_telegram) DO UPDATE SET
                     cd_conteudo = EXCLUDED.cd_conteudo,
                     status = EXCLUDED.status,
                     dispositivo = EXCLUDED.dispositivo,
                     ultima_atividade = EXCLUDED.ultima_atividade`,
                [nr_id_telegram, validContentId, 'ONLINE', dispositivo || "Desconhecido", new Date().toISOString()]
            );
        } catch (sessError) {
            console.error("Erro na gravação da sessão:", sessError.message);
        }

        // Sempre respondemos 200. Mesmo que o radar falhe, o cliente NÃO pode ser prejudicado.
        res.sendStatus(200);
    } catch (e) { 
        res.sendStatus(200); 
    }
});

// =================================================================
// 📼 API DE HISTÓRICO (CONTINUAR ASSISTINDO)
// =================================================================

// 1. Salva o progresso a cada X segundos
app.post("/api/historico", async (req, res) => {
    const { nr_id_telegram, cd_conteudo, cd_episodio, tempo_atual, tempo_total } = req.body;
    
    // Filtro contra erros de UUID ou IDs zerados
    if (!nr_id_telegram || !cd_conteudo || cd_conteudo.length !== 36) return res.sendStatus(400);

    try {
        await pool.query(
            `INSERT INTO "HISTORICO" (nr_id_telegram, cd_conteudo, cd_episodio, nr_tempo_atual, nr_tempo_total, ts_atualizacao)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (nr_id_telegram, cd_conteudo) DO UPDATE SET
                 cd_episodio = EXCLUDED.cd_episodio,
                 nr_tempo_atual = EXCLUDED.nr_tempo_atual,
                 nr_tempo_total = EXCLUDED.nr_tempo_total,
                 ts_atualizacao = EXCLUDED.ts_atualizacao`,
            [nr_id_telegram, cd_conteudo, cd_episodio || null, Math.floor(tempo_atual), Math.floor(tempo_total) || 100, new Date().toISOString()]
        );

        res.sendStatus(200);
    } catch (e) {
        res.sendStatus(500);
    }
});

// 2. Busca a lista de Continue Assistindo do cliente
app.get("/api/historico", async (req, res) => {
    const { userId } = req.query;
    if (!userId || userId === "0" || userId === "undefined") return res.json([]);

    try {
        const { rows } = await pool.query(
            `SELECT h.nr_tempo_atual, h.nr_tempo_total, h.cd_conteudo, h.cd_episodio,
                    c.nm_titulo AS "conteudoTitulo", c.ds_url_poster AS "conteudoPoster", c.tp_formato AS "conteudoFormato"
             FROM "HISTORICO" h
             LEFT JOIN "CONTEUDOS" c ON c.cd_conteudo = h.cd_conteudo
             WHERE h.nr_id_telegram = $1
             ORDER BY h.ts_atualizacao DESC
             LIMIT 10`,
            [userId]
        );

        const data = rows.map(h => ({
            nr_tempo_atual: h.nr_tempo_atual,
            nr_tempo_total: h.nr_tempo_total,
            cd_conteudo: h.cd_conteudo,
            cd_episodio: h.cd_episodio,
            CONTEUDOS: h.conteudoTitulo != null ? {
                nm_titulo: h.conteudoTitulo,
                ds_url_poster: h.conteudoPoster,
                tp_formato: h.conteudoFormato
            } : null
        }));

        res.json(data || []);
    } catch (e) {
        console.error("Erro ao buscar histórico:", e.message);
        res.json([]);
    }
});

// =================================================================
// 📺 API DE EPISÓDIOS (SÉRIES E CURSOS)
// =================================================================
app.get("/api/episodes", async (req, res) => {
    const { conteudoId } = req.query;
    try {
        const { rows: episodios } = await pool.query(
            'SELECT * FROM "EPISODIOS" WHERE cd_conteudo = $1 ORDER BY nr_episodio ASC',
            [conteudoId]
        );
        res.json(episodios || []);
    } catch (error) {
        console.error("❌ [ERRO BUSCAR EPISODIOS]:", error.message);
        res.status(500).json({ error: "Erro ao buscar episódios" });
    }
});

// Webhook Efí Bank
app.post("/webhook-efi", async (req, res) => {
  console.log("🔔 [WEBHOOK] O carteiro da Efí bateu na porta!", JSON.stringify(req.body));
  res.sendStatus(200);

  if (req.body && req.body.pix) {
      for (const pagamento of req.body.pix) {
          const txidPago = pagamento.txid;

          try {
              // Busca a venda pendente com esse TXID
              const { rows: vendaRows } = await pool.query(
                  `SELECT v.*, p.nr_dias_validade AS "planoDiasValidade"
                   FROM "VENDAS" v
                   LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
                   WHERE v.ds_txid = $1 AND v.tp_status = $2
                   LIMIT 1`,
                  [txidPago, "PENDENTE"]
              );
              const venda = vendaRows[0];

              if (!venda) continue; // Ignora se não achou ou já foi paga

              const type = venda.tp_compra;
              let diasValidade = type === "ALUGUEL" ? 7 : type === "VITALICIO" ? 18250 : 30;

              if (type === "ASSINATURA" && venda.planoDiasValidade) {
                  diasValidade = venda.planoDiasValidade;
              }

              const ts_expiracao = new Date();
              ts_expiracao.setDate(ts_expiracao.getDate() + diasValidade);

              // Atualiza o banco
              await pool.query(
                  'UPDATE "VENDAS" SET tp_status = $1, ts_expiracao = $2 WHERE ds_txid = $3',
                  ["APROVADA", ts_expiracao.toISOString(), txidPago]
              );

              catalogCache.data = null; // Ranking reflete nova venda em tempo real
              console.log(`✅ [EFÍ] Venda APROVADA no sistema! TXID: ${txidPago}`);

              // Envia mensagem pro cliente (venda.nr_id_telegram)
              const textoAcesso = (venda.tp_compra === "ASSINATURA") 
                  ? "Seu **Acesso Premium** foi liberado! 👑" 
                  : "Seu **Filme** foi liberado com sucesso! 🎬";

              // Envia mensagem pro cliente (venda.nr_id_telegram)
              await bot.telegram.sendMessage(
                  venda.nr_id_telegram,
                  `🎉 **PAGAMENTO CONFIRMADO!**\n\n${textoAcesso}\nAbra o aplicativo e confira a aba **MINHA LISTA** para assistir agora! 🍿`,
                  {
                      parse_mode: "Markdown",
                      reply_markup: { inline_keyboard: [[{ text: "🚀 ABRIR MELREELS", web_app: { url: process.env.WEBAPP_URL } }]] }
                  }
              ).catch(() => console.log("⚠️ Cliente bloqueou o bot."));

          } catch (err) {
              console.error("❌ Erro processando PIX da Efí:", err.message);
          }
      }
  }
});

// =================================================================
// 4. LÓGICA DO BOT (COMANDOS E EVENTOS)
// =================================================================

// =================================================================
// Comando /start - Fixo e Limpo (Apenas Imagem)
// =================================================================
bot.start(async (ctx) => {
  const payload = ctx.payload;

  let webAppUrl = process.env.WEBAPP_URL;
  let mensagem = `🎬 **Bem-vindo ao Melreels Streaming!**\n\nFala, ${ctx.from.first_name}! Preparado para maratonar?\n\nClique no botão abaixo para acessar nosso catálogo exclusivo de dramas, lançamentos e curtas gerados por IA. 🍿🔥`;
  let textoBotao = "📺 ABRIR CATÁLOGO";

  if (payload) {
    const codeClean = payload.replace("vincular_", "").trim();
    if (/^\d{6}$/.test(codeClean)) {
      try {
        const agora = new Date().toISOString();
        const { rows: data } = await pool.query(
          `UPDATE "VINCULACOES_TELEGRAM"
           SET nr_id_telegram = $1, tp_status = $2, ts_confirmacao = $3
           WHERE cd_codigo = $4 AND tp_status = $5 AND ts_expiracao > $6
           RETURNING *`,
          [ctx.from.id, 'CONFIRMADO', agora, codeClean, "PENDENTE", agora]
        );

        if (data && data.length > 0) {
          return ctx.reply("✅ **Conta vinculada com sucesso!**\n\nSua conta na plataforma agora está conectada a este Telegram. Você já pode voltar para o navegador.", { parse_mode: "Markdown" });
        } else {
          return ctx.reply("❌ **Código de vinculação inválido ou expirado.**\nGere um novo código no site e tente novamente.", { parse_mode: "Markdown" });
        }
      } catch (err) {
        console.error("Erro ao vincular pelo start:", err.message);
      }
    }

    webAppUrl = `${process.env.WEBAPP_URL}?movie=${payload}`;
    mensagem = `🎬 **Você recebeu uma recomendação!**\n\nFala, ${ctx.from.first_name}! Clicaram em um link direto para um conteúdo incrível.\n\nClique no botão abaixo para abrir o Melreels e assistir agora mesmo! 🍿🔥`;
    textoBotao = "▶️ ABRIR FILME";
  }

  // 🎯 Busca a foto direto do banco (Mais rápido e blindado)
  let fotoStart = "https://i.imgur.com/S86Pj0e.jpeg"; // Imagem padrão absoluta

  try {
      const { rows } = await pool.query(
          'SELECT valor_config FROM "CONFIGURACOES" WHERE nome_config = $1 LIMIT 1',
          ["FOTO_START"]
      );
      const data = rows[0];

      if (data && data.valor_config) {
          fotoStart = data.valor_config; // Puxa a foto que a Mell colocou lá no /admin
      }
  } catch (e) {
      console.log("⚠️ FOTO_START não encontrada no banco, usando padrão.");
  }

  try {
      await ctx.replyWithPhoto(fotoStart, {
          caption: mensagem,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: textoBotao, web_app: { url: webAppUrl } }]] }
      });
  } catch (err) {
      console.error("❌ Erro ao enviar a foto de start:", err.message);
      // Se a foto falhar, manda só texto pra não deixar o cliente no vácuo
      await ctx.reply(mensagem, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: textoBotao, web_app: { url: webAppUrl } }]] }
      });
  }
});

// Comando /add (Apenas Admins)
bot.command("add", (ctx) => {
  const admins = process.env.ADMIN_IDS.split(",");
  if (admins.includes(ctx.from.id.toString())) {
    ctx.scene.enter("ADICIONAR_DRAMA_SCENE");
  } else {
    ctx.reply("🚫 Comando restrito. Você não tem permissões de administrador.");
  }
});

bot.command("getid", async (ctx) => {
  const text = ctx.message.text.split(" ");
  if (text.length < 2)
    return ctx.reply("ℹ️ **Uso correto:** `/getid @username`", {
      parse_mode: "Markdown",
    });

  try {
    const chat = await ctx.telegram.getChat(text[1]);
    ctx.reply(
      `🔍 **INFO ENCONTRADA:**\n\nNome: ${chat.first_name || chat.title}\nID: \`${chat.id}\``,
      { parse_mode: "Markdown" },
    );
  } catch (e) {
    ctx.reply(
      "❌ Não encontrei. O perfil precisa ser público ou o bot precisa já ter interagido com a pessoa.",
    );
  }
});

// =================================================================
// 🔗 FLUXO DE VINCULAÇÃO DE CONTA (WEB -> TELEGRAM)
// =================================================================
bot.command("vincular", async (ctx) => {
  const partes = ctx.message.text.split(" ");
  if (partes.length < 2) {
    return ctx.reply("⚠️ Formato incorreto. Use: `/vincular SEU_CODIGO`\nExemplo: `/vincular 123456`", { parse_mode: "Markdown" });
  }

  const codigo = partes[1].trim();
  const userIdTelegram = ctx.from.id; // Mantido como número para bater com o int8 do banco

  const loadingMsg = await ctx.reply("⏳ Verificando código de vinculação...");

  try {
    const agora = new Date().toISOString();

    const { rows: data } = await pool.query(
      `UPDATE "VINCULACOES_TELEGRAM"
       SET nr_id_telegram = $1, tp_status = $2, ts_confirmacao = $3
       WHERE cd_codigo = $4 AND tp_status = $5 AND ts_expiracao > $6
       RETURNING *`,
      [userIdTelegram, 'CONFIRMADO', agora, codigo, "PENDENTE", agora]
    );

    if (!data || data.length === 0) {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      return ctx.reply("❌ **Código inválido, expirado ou já utilizado.**\nGere um novo código na plataforma e tente novamente.", { parse_mode: "Markdown" });
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    await ctx.reply("✅ **Conta vinculada com sucesso!**\n\nSua conta na plataforma agora está conectada a este Telegram. Você já pode voltar para o navegador.", { parse_mode: "Markdown" });

  } catch (err) {
    console.error("❌ Erro ao vincular conta:", err.message);
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    await ctx.reply("❌ Ocorreu um erro interno ao processar a vinculação. Tente novamente mais tarde.");
  }
});

bot.command("admin", async (ctx) => {
  // 🛡️ Proteção Sênior: Se o .env estiver vazio, vira uma string vazia antes do split e não crasha!
  const admins = (process.env.ADMIN_IDS || "").split(",");
  
  if (!admins.includes(ctx.from.id.toString())) {
    return ctx.reply(`🚫 Acesso negado. Seu ID do Telegram é \`${ctx.from.id}\`.\n\nPara acessar o painel de administração, adicione este ID na variável \`ADMIN_IDS\` no seu arquivo \`.env\` e reinicie o servidor.`, { parse_mode: "Markdown" });
  }
  
  await ctx.reply("⚙️ **PAINEL DE ADMINISTRAÇÃO**\n\nO que você deseja fazer?", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Ver Lista de Filmes e IDs", callback_data: "ADMIN_LISTAR_IDS" }],
        [{ text: "👤 Gerenciar Cliente (Dar/Tirar/Banir)", callback_data: "ADMIN_GERENCIAR_CLIENTE" }],
        [{ text: "🖼️ Trocar Banner de um Conteúdo", callback_data: "ADMIN_TROCAR_BANNER" }],
        [{ text: "📸 Trocar Foto do /start", callback_data: "ADMIN_TROCAR_START" }],
        [{ text: "🔄 Atualizar Filme/Série", callback_data: "ADMIN_ATUALIZAR_FILME" }],
        [{ text: "📦 Criar Novo Plano", callback_data: "ADMIN_CRIAR_PLANO" }],
        [{ text: "📺 Adicionar Episódio (Série)", callback_data: "ADMIN_ADD_EPISODIO" }],
        [{ text: "✍️ Editar Definição de Plano (Nome/Cat)", callback_data: "ADMIN_EDITAR_DEFINICAO_PLANO" }],
		[{ text: "🗑️ Excluir Plano de Assinatura", callback_data: "ADMIN_EXCLUIR_PLANO" }],
        [{ text: "💲 Criar Promoção / Mudar Preço", callback_data: "ADMIN_ALTERAR_PRECO" }],
        [{ text: "🗑️ Excluir Conteúdo do Catálogo", callback_data: "ADMIN_EXCLUIR_CONTEUDO" }],
        [{ text: "🔗 Gerar Link de Divulgação (Para Grupos)", callback_data: "ADMIN_GERAR_LINK" }],
		[{ text: "📢 Enviar Aviso Global (Broadcast)", callback_data: "ADMIN_TRANSMITIR" }],
        [{ text: "📅 Ver Assinaturas Vencidas", callback_data: "ADMIN_VER_VENCIDOS" }],
        [{ text: "🎡 Editar Carrossel (Topo do App)", callback_data: "ADMIN_EDITAR_CARROSSEL" }],
        [{ text: "🔍 Consultar TXID (Pix)", callback_data: "ADMIN_CONSULTAR_TXID" }],
        [{ text: "📡 Quem está Online Agora?", callback_data: "ADMIN_VER_ONLINE" }],
        [{ text: "🔥 Reiniciar Servidor", callback_data: "ADMIN_RESTART_PM2" }],
        [{ text: "❌ Fechar Painel", callback_data: "FECHAR_ADMIN" }]
      ]
    }
  });
});


// 🚀 NOVO COMANDO: RELATÓRIO DE VENDAS PARA O CLIENTE
bot.command("ranking", async (ctx) => {
    const admins = process.env.ADMIN_IDS.split(",");
    if (!admins.includes(ctx.from.id.toString())) {
      return ctx.reply(`🚫 Acesso negado. Seu ID do Telegram é \`${ctx.from.id}\`.`, { parse_mode: "Markdown" });
    }
    
    const inicioMes = new Date();
    const nomeMes = inicioMes.toLocaleString('pt-BR', { month: 'long' }).toUpperCase();
    await ctx.reply(`⏳ Calculando ranking de **${nomeMes}**...`);
    
    try {
        // 🚀 Puxa direto da View (100% blindado contra o limite de 1000 linhas)
        const { rows: rankingDb } = await pool.query('SELECT nm_titulo, total_vendas FROM vw_ranking_mensal');

        if(!rankingDb || rankingDb.length === 0) return ctx.reply(`❌ Nenhuma venda aprovada em ${nomeMes} ainda.`);
        
        // Ordena por vendas e aplica desempate alfabético
        const rankingFinal = rankingDb.sort((a,b) => {
            if (b.total_vendas !== a.total_vendas) return b.total_vendas - a.total_vendas;
            return (a.nm_titulo || "").localeCompare(b.nm_titulo || "");
        }).slice(0, 15);
        
        let txt = `🏆 **TOP 15 - ${nomeMes}:**\n\n`;
        rankingFinal.forEach((item, index) => {
            txt += `**${index + 1}º** - ${item.nm_titulo} (${item.total_vendas} vendas)\n`;
        });
        
        ctx.reply(txt, { parse_mode: "Markdown" });
    } catch (e) {
        console.error(e);
        ctx.reply("❌ Erro ao puxar relatório mensal.");
    }
});

// 🔍 NOVO COMANDO: BUSCAR FILME RÁPIDO
bot.command("buscar", async (ctx) => {
    const admins = process.env.ADMIN_IDS.split(",");
    if (!admins.includes(ctx.from.id.toString())) return;

    const termo = ctx.message.text.replace("/buscar", "").trim();
    if (!termo) {
        return ctx.reply("ℹ️ **Uso correto:** `/buscar Nome do Filme`\n*(Exemplo: /buscar Vingadores)*", { parse_mode: "Markdown" });
    }

    try {
        // Busca no banco (ilike ignora maiúsculas e minúsculas)
        const { rows: filmes } = await pool.query(
            'SELECT cd_conteudo, nm_titulo, nm_categoria FROM "CONTEUDOS" WHERE nm_titulo ILIKE $1 LIMIT 10',
            [`%${termo}%`]
        );

        if (!filmes || filmes.length === 0) {
            return ctx.reply(`❌ Nenhum filme encontrado com a palavra "${termo}".`);
        }

        let txt = `🔍 **RESULTADOS DA BUSCA:**\n\n`;
        filmes.forEach(f => {
            txt += `🎬 **${f.nm_titulo}**\n📂 Categoria Atual: *${f.nm_categoria || "Nenhuma"}*\n🆔 ID: \`${f.cd_conteudo}\`\n\n`;
        });
        txt += `*(Copie o ID acima e use no menu /admin para editar)*`;

        ctx.reply(txt, { parse_mode: "Markdown" });
    } catch (e) {
        ctx.reply("❌ Erro ao buscar o filme.");
    }
});

// 📂 NOVO COMANDO: LISTAR CATEGORIAS EXISTENTES
bot.command("categorias", async (ctx) => {
    const admins = process.env.ADMIN_IDS.split(",");
    if (!admins.includes(ctx.from.id.toString())) return;

    await ctx.reply("⏳ Extraindo categorias do banco de dados...");

    try {
        // Busca a coluna de categorias de todos os filmes
        const { rows: data } = await pool.query('SELECT nm_categoria FROM "CONTEUDOS"');

        // 🚀 O Pulo do Gato: Pega só os nomes, remove os nulos e usa o "Set" para remover as duplicatas!
        const categoriasUnicas = [...new Set(data.map(item => item.nm_categoria).filter(Boolean))].sort();

        if (categoriasUnicas.length === 0) {
            return ctx.reply("❌ Nenhuma categoria cadastrada nos filmes ainda.");
        }

        let txt = "📂 **CATEGORIAS ATIVAS NOS FILMES:**\n\n";
        categoriasUnicas.forEach(cat => {
            txt += `🔸 ${cat}\n`;
        });
        
        txt += `\n*(Use esses exatos nomes quando for criar um Plano novo)*`;

        ctx.reply(txt, { parse_mode: "Markdown" });
    } catch (e) {
        console.error(e);
        ctx.reply("❌ Erro ao buscar categorias.");
    }
});

// 💎 NOVO COMANDO: CONFERIR OS PLANOS E SEUS ACESSOS
bot.command("planos", async (ctx) => {
    const admins = process.env.ADMIN_IDS.split(",");
    if (!admins.includes(ctx.from.id.toString())) return;

    try {
        const { rows: planos } = await pool.query(
            'SELECT cd_plano, nm_plano, nm_categoria, vl_plano FROM "PLANOS" ORDER BY vl_plano ASC'
        );

        if (!planos || planos.length === 0) {
            return ctx.reply("❌ Nenhum plano cadastrado no banco de dados.");
        }

        let txt = "💎 **AUDITORIA DE PLANOS:**\n\n";
        planos.forEach(p => {
            txt += `👑 **${p.nm_plano}** (R$ ${p.vl_plano})\n`;
            txt += `🔓 Libera a Categoria: *${p.nm_categoria}*\n`;
            txt += `🆔 ID: \`${p.cd_plano}\`\n\n`;
        });
        
        txt += `*(Lembrando: Se a categoria do plano estiver como "TODAS", ele libera o app inteiro!)*`;

        ctx.reply(txt, { parse_mode: "Markdown" });
    } catch (e) {
        console.error(e);
        ctx.reply("❌ Erro ao buscar planos.");
    }
});

bot.action("ADMIN_VER_ONLINE", async (ctx) => {
    await ctx.answerCbQuery("Buscando radar...").catch(()=>{});
    
    // Consideramos "Online" quem mandou sinal nos últimos 2 minutos
    const limite = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    try {
        // Faz o JOIN com CONTEUDOS para puxar o nome do filme baseado no UUID
        const { rows: online } = await pool.query(
            `SELECT s.nr_id_telegram, s.dispositivo, s.ultima_atividade, c.nm_titulo AS "conteudoTitulo"
             FROM "SESSOES" s
             LEFT JOIN "CONTEUDOS" c ON c.cd_conteudo = s.cd_conteudo
             WHERE s.ultima_atividade > $1
             ORDER BY s.ultima_atividade DESC`,
            [limite]
        );

        if (!online || online.length === 0) {
            return ctx.reply("💤 **Ninguém online no momento.**", { parse_mode: "Markdown" });
        }

        let msg = `📡 **RADAR EM TEMPO REAL**\n`;
        msg += `👥 Total: **${online.length} usuários**\n\n`;

        online.forEach(u => {
            const dataAtividade = new Date(u.ultima_atividade).toLocaleTimeString('pt-BR');
            // Se tiver filme no Join, mostra. Se for Null, ele tá no menu principal
            const titulo = u.conteudoTitulo || "Navegando no Catálogo";
            
            // Formatando o nome do dispositivo para ficar mais bonito
            let disp = u.dispositivo;
            if (disp === "ios") disp = "🍎 iPhone";
            else if (disp === "android") disp = "🤖 Android";
            else if (disp === "tdesktop") disp = "💻 PC Windows";
            else if (disp === "web") disp = "🌐 Navegador Web";
            
            msg += `👤 [Cliente](tg://user?id=${u.nr_id_telegram}) (\`${u.nr_id_telegram}\`)\n`;
            msg += `🎬 Vendo: *${titulo}*\n`;
            msg += `📱 Aparelho: ${disp}\n`;
            msg += `⏱️ Último sinal: ${dataAtividade}\n\n`;
        });

        await ctx.reply(msg, { parse_mode: "Markdown" });

    } catch (err) {
        console.error(err);
        await ctx.reply("❌ Erro ao consultar radar.");
    }
});




bot.command("setwebhook", async (ctx) => {
  const admins = process.env.ADMIN_IDS.split(",");
  if (!admins.includes(ctx.from.id.toString())) return;

  // ⚠️ MUITO IMPORTANTE: Coloque AQUI a URL do seu Cloudflare/Servidor sem barra no final!
  const MEU_DOMINIO = "https://melreels.com.br"; 

  await ctx.reply("⏳ Enviando URL do Webhook para a Efí Bank...");
  
  try {
      await efiService.configurarWebhook(MEU_DOMINIO);
      await ctx.reply(`✅ Webhook configurado com sucesso para apontar para:\n\n\`${MEU_DOMINIO}/webhook-efi\``, { parse_mode: "Markdown" });
  } catch (err) {
      console.error(err);
      await ctx.reply("❌ Erro ao configurar o webhook. Olhe os logs do servidor.");
  }
});
// =================================================================
// 📸 FERRAMENTA DE ADMIN: GERADOR DE LINK DE IMAGEM (HOSTING)
// =================================================================
bot.on("photo", async (ctx) => {
  // Escudo: Se você estiver no meio de um cadastro/cena, deixa a cena cuidar da foto!
  if (ctx.session?.__scenes?.current) return;

  // 1. Verifica se quem mandou a foto é Admin
  const admins = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(",") : [];
  if (!admins.includes(ctx.from.id.toString())) return;

  const loadingMsg = await ctx.reply("⏳ Transformando imagem em Link URL permanente...");

  try {
    // 2. Pega o ID da foto com maior resolução enviada
    const fotoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    
    // 3. Pega o link temporário interno do Telegram
    const fileLink = await ctx.telegram.getFileLink(fotoId);

    // 4. Usa 'arraybuffer' para baixar a foto inteira pra memória
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

    // 5. Prepara o formulário convertendo o Buffer da memória
    const form = new FormData();
    // 🎯 O PULO DO GATO AQUI TAMBÉM: Avisando pra API que é um JPEG!
    form.append("file", Buffer.from(response.data), {
        filename: "banner.jpg",
        contentType: "image/jpeg"
    });

    // 6. Faz o Upload direto pra nuvem
    const upload = await axios.post("https://telegra.ph/upload", form, {
        headers: form.getHeaders(),
    });

    // 7. Monta o link final e devolve pro Admin
    if (upload.data && upload.data[0] && upload.data[0].src) {
        const urlFinal = `https://telegra.ph${upload.data[0].src}`;
        
        await ctx.reply(`✅ **Link Gerado com Sucesso!**\n\nCopie o link abaixo e use no cadastro de filmes ou na troca de banners:\n\n\`${urlFinal}\`\n\n*(Toque no link acima para copiar direto)*`, { parse_mode: "Markdown" });
    } else {
        throw new Error("Erro na resposta do Telegraph");
    }
  } catch (err) {
    console.error("❌ Erro ao gerar link de foto:", err.message);
    await ctx.reply("❌ Não foi possível processar a imagem. Tente novamente com outra foto.");
  } finally {
    // Apaga a mensagem de "carregando"
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
  }
});

// 2. Ação: Ver quem venceu
bot.action("ADMIN_VER_VENCIDOS", async (ctx) => {
  await ctx.answerCbQuery();
  const agora = new Date().toISOString();

  // Busca vendas aprovadas mas que a data de expiração já passou
  const { rows: vencidos } = await pool.query(
    `SELECT v.nr_id_telegram, v.ts_expiracao, v.tp_compra,
            c.nm_titulo AS "conteudoTitulo", p.nm_plano AS "planoNome"
     FROM "VENDAS" v
     LEFT JOIN "CONTEUDOS" c ON c.cd_conteudo = v.cd_conteudo
     LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
     WHERE v.tp_status = $1 AND v.ts_expiracao < $2
     ORDER BY v.ts_expiracao DESC
     LIMIT 10`,
    ["APROVADA", agora]
  );

  if (!vencidos || vencidos.length === 0) {
    return ctx.reply("✅ Nenhum acesso vencido encontrado recentemente.");
  }

  let texto = "📅 **ÚLTIMOS ACESSOS VENCIDOS:**\n\n";
  vencidos.forEach(v => {
    const item = v.tp_compra === "ASSINATURA" ? v.planoNome : v.conteudoTitulo;
    const dataVenc = new Date(v.ts_expiracao).toLocaleDateString('pt-BR');
    texto += `👤 ID: \`${v.nr_id_telegram}\`\n🍿 Item: ${item}\n⏱ Venceu em: ${dataVenc}\n\n`;
  });

  await ctx.reply(texto, { parse_mode: "Markdown" });
});

bot.action("FECHAR_ADMIN", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
});

// =================================================================
// HANDLERS DO SISTEMA DE UPSELL INTELIGENTE
// =================================================================

bot.action("UPSELL_VER_PLANOS", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  
  try {
      const { rows: planos } = await pool.query('SELECT * FROM "PLANOS" ORDER BY vl_plano ASC');

      if (!planos || planos.length === 0) {
          return ctx.reply("❌ Nenhum plano de assinatura disponível no momento.");
      }
      
      let msg = "👑 **Nossos Planos de Assinatura:**\n\nEscolha um dos planos abaixo para liberar o acesso:\n\n";
      const botoes = [];
      
      planos.forEach(p => {
          let preco = p.vl_plano;
          let precoTexto = `R$ ${preco.toFixed(2).replace('.', ',')}`;
          
          msg += `💎 **${p.nm_plano}**\n📂 Libera: *${p.nm_categoria}*\n⏱️ Validade: *${p.nr_dias_validade} dias*\n💰 Preço: *${precoTexto}*\n\n`;
          
          botoes.push([Markup.button.callback(`🚀 Assinar ${p.nm_plano}`, `COMPRAR_PLANO_${p.cd_plano}`)]);
      });
      
      await ctx.reply(msg, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard(botoes)
      });
  } catch (err) {
      console.error("❌ Erro ao listar planos para upsell:", err.message);
      await ctx.reply("❌ Erro ao buscar planos de assinatura.");
  }
});

bot.action("UPSELL_RECUSAR", async (ctx) => {
  await ctx.answerCbQuery("Sem problema! Estamos aqui quando quiser 😊").catch(() => {});
  await ctx.deleteMessage().catch(() => {});
});

bot.action("ADMIN_TRANSMITIR", (ctx) => {
  ctx.scene.enter("TRANSMITIR_AVISO_SCENE");
});

bot.action("UPSELL_CONTINUAR_COMPRA", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  
  const pending = ctx.session?.dadosCompraPendente;
  if (!pending) {
      return ctx.reply("❌ Não encontramos nenhuma compra pendente.");
  }
  
  ctx.session.aguardandoDecisaoUpsell = false;
  ctx.session.dadosCompraPendente = null;
  
  const { id_origem, nr_id_telegram, modalidade } = pending;
  const loadingMsg = await ctx.reply("⌛ Gerando o Pix da sua compra original...");
  
  try {
      let valor, titulo, insertData;
      if (modalidade === "ASSINATURA") {
          const { rows: planoRows } = await pool.query('SELECT * FROM "PLANOS" WHERE cd_plano = $1 LIMIT 1', [id_origem]);
          const plano = planoRows[0];
          if (!plano) throw new Error("Plano não encontrado.");

          valor = plano.vl_plano;
          titulo = `Assinatura: ${plano.nm_plano}`;
          insertData = { cd_plano: id_origem, nr_id_telegram, tp_compra: "ASSINATURA" };
      } else {
          const { rows: itemRows } = await pool.query('SELECT * FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1', [id_origem]);
          const item = itemRows[0];
          if (!item) throw new Error("Conteúdo não encontrado.");

          valor = modalidade === "ALUGUEL" ? item.vl_aluguel : item.vl_vitalicio;
          titulo = `${item.nm_titulo} (${modalidade})`;
          insertData = { cd_conteudo: id_origem, nr_id_telegram, tp_compra: modalidade };
      }

      const pix = await efiService.gerarPix(valor, titulo, nr_id_telegram, id_origem, modalidade);

      const vendaData2 = { ...insertData, tp_status: "PENDENTE", ds_txid: pix.txid };
      const vendaColunas2 = Object.keys(vendaData2);
      const vendaPlaceholders2 = vendaColunas2.map((_, i) => `$${i + 1}`).join(", ");
      await pool.query(
          `INSERT INTO "VENDAS" (${vendaColunas2.join(", ")}) VALUES (${vendaPlaceholders2})`,
          vendaColunas2.map(col => vendaData2[col])
      );

      let base64Code = pix.qrCode || "";
      if (base64Code.includes(",")) {
          base64Code = base64Code.split(",")[1];
      }
      
      await ctx.replyWithPhoto({ source: Buffer.from(base64Code, "base64") }, {
          caption: `🍿 **Item: ${titulo}**\n💰 Valor: R$ ${valor.toFixed(2).replace('.', ',')}\n\nEscaneie o QR Code acima ou copie a chave Pix abaixo para pagar:\n\n\`${pix.copyPaste}\`\n\n*(Toque no código acima para copiar)*`,
          parse_mode: "Markdown"
      });
  } catch (err) {
      console.error("❌ Erro ao gerar Pix da compra pendente no bot:", err.message);
      await ctx.reply("❌ Não foi possível gerar a compra pendente. Abra o aplicativo e tente novamente.");
  } finally {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
  }
});

bot.action(/COMPRAR_PLANO_(.+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const planId = ctx.match[1];
  const userId = ctx.from.id;
  
  const loadingMsg = await ctx.reply("⌛ Gerando seu Pix de Assinatura, aguarde...");
  
  try {
      const { rows: planoRows } = await pool.query('SELECT * FROM "PLANOS" WHERE cd_plano = $1 LIMIT 1', [planId]);
      const plano = planoRows[0];

      if (!plano) {
          return ctx.reply("❌ Plano não encontrado.");
      }

      let valor = plano.vl_plano;
      let titulo = `Assinatura: ${plano.nm_plano}`;

      const pix = await efiService.gerarPix(valor, titulo, userId, planId, "ASSINATURA");

      await pool.query(
          `INSERT INTO "VENDAS" (cd_plano, nr_id_telegram, tp_compra, tp_status, ds_txid) VALUES ($1, $2, $3, $4, $5)`,
          [planId, userId, "ASSINATURA", "PENDENTE", pix.txid]
      );

      let base64Code = pix.qrCode || "";
      if (base64Code.includes(",")) {
          base64Code = base64Code.split(",")[1];
      }
      
      await ctx.replyWithPhoto({ source: Buffer.from(base64Code, "base64") }, {
          caption: `👑 **Plano: ${plano.nm_plano}**\n💰 Valor: R$ ${valor.toFixed(2).replace('.', ',')}\n\nEscaneie o QR Code acima ou copie a chave Pix abaixo para pagar:\n\n\`${pix.copyPaste}\`\n\n*(Toque no código acima para copiar)*`,
          parse_mode: "Markdown"
      });
  } catch (err) {
      console.error("❌ Erro ao gerar Pix para plano no bot:", err.message);
      await ctx.reply("❌ Ocorreu um erro ao gerar o pagamento. Tente novamente mais tarde.");
  } finally {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
  }
});

// --- AÇÃO PARA LISTAR TODOS OS IDs ---
bot.action("ADMIN_LISTAR_IDS", async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  
  try {
    // Busca todos os conteúdos ordenados por nome em ordem alfabética
    const { rows: conteudos } = await pool.query(
      'SELECT cd_conteudo, nm_titulo, tp_formato FROM "CONTEUDOS" ORDER BY nm_titulo ASC'
    );

    if (!conteudos || conteudos.length === 0) {
      return ctx.reply("❌ O catálogo está vazio no momento.");
    }

    let mensagemAtual = "📋 **LISTA DE TODOS OS FILMES E IDs:**\n\n";
    let filaDeMensagens = [];

    // Prepara a lista e divide em várias mensagens se ficar muito grande pro Telegram
    conteudos.forEach((c) => {
      const formato = c.tp_formato ? c.tp_formato : "CONTEÚDO";
      const linha = `🎬 **${c.nm_titulo}** (${formato})\nID: \`${c.cd_conteudo}\`\n\n`;
      
      // Se a mensagem bater 3800 caracteres, salva na fila e começa uma nova
      if ((mensagemAtual.length + linha.length) > 3800) {
        filaDeMensagens.push(mensagemAtual);
        mensagemAtual = ""; 
      }
      mensagemAtual += linha;
    });
    filaDeMensagens.push(mensagemAtual); // Coloca a última parte na fila

    // Envia a fila inteira de mensagens
    for (const msg of filaDeMensagens) {
      await ctx.reply(msg, { parse_mode: "Markdown" });
    }

  } catch (err) {
    console.error("❌ [ERRO LISTAR IDS]:", err.message);
    await ctx.reply("❌ Erro ao buscar os conteúdos no banco de dados.");
  }
});


bot.action("ADMIN_EDITAR_CARROSSEL", (ctx) => {
  ctx.scene.enter("EDITAR_CARROSSEL_SCENE");
});

bot.action("ADMIN_ATUALIZAR_FILME", (ctx) => {
  ctx.scene.enter("ATUALIZAR_FILME_SCENE");
});

bot.action("ADMIN_GERAR_LINK", (ctx) => {
  ctx.scene.enter("GERAR_LINK_SCENE");
});

bot.action("ADMIN_GERENCIAR_CLIENTE", (ctx) => {
  ctx.scene.enter("GERENCIAR_CLIENTE_SCENE");
});

bot.action("ADMIN_CONSULTAR_TXID", (ctx) => {
  ctx.scene.enter("CONSULTAR_TXID_SCENE");
});

bot.action("ADMIN_EXCLUIR_CONTEUDO", (ctx) => {
  ctx.scene.enter("EXCLUIR_CONTEUDO_SCENE");
});

bot.action("ADMIN_TROCAR_BANNER", (ctx) => {
  ctx.scene.enter("ALTERAR_BANNER_SCENE");
});

// =================================================================
// 🔥 DEVOPS: REINICIAR SERVIDOR VIA PM2
// =================================================================
bot.action("ADMIN_RESTART_PM2", async (ctx) => {
    // 1. Tira o loading do botão
    await ctx.answerCbQuery();
    
    // 2. Avisa que vai cair (Isso tem que ser ANTES de rodar o comando, senão ele morre e não manda)
    await ctx.editMessageText("🔥 **Atenção:** O servidor está sendo reiniciado...\n\nO bot e o aplicativo ficarão offline por cerca de 5 a 10 segundos e voltarão automaticamente.", { parse_mode: "Markdown" });

    // 3. Railway reinicia o processo sozinho (restartPolicyType: ON_FAILURE no railway.json)
    // ao detectar saída com código de erro — não há PM2 rodando neste ambiente.
    process.exit(1);
});

bot.action("ADMIN_TROCAR_START", (ctx) => {
  ctx.scene.enter("ALTERAR_START_SCENE");
});

bot.action("ADMIN_ALTERAR_PRECO", (ctx) => {
  ctx.scene.enter("ALTERAR_PRECO_PLANO_SCENE");
});

bot.action("ADMIN_CRIAR_PLANO", (ctx) => {
  ctx.scene.enter("CRIAR_PLANO_SCENE");
});

bot.action("ADMIN_EXCLUIR_PLANO", (ctx) => {
  ctx.scene.enter("EXCLUIR_PLANO_SCENE");
});

bot.action("ADMIN_EDITAR_DEFINICAO_PLANO", (ctx) => {
  ctx.scene.enter("EDITAR_NOME_CATEGORIA_PLANO_SCENE");
});

bot.action("ADMIN_ADD_EPISODIO", (ctx) => {
  ctx.scene.enter("ADICIONAR_EPISODIO_SCENE");
});

// =================================================================
// 📸 FERRAMENTA DE ADMIN: GERADOR DE LINK DE IMAGEM (HOSTING)
// =================================================================
bot.on("photo", async (ctx) => {
  // Escudo: Se você estiver no meio de um cadastro/cena, deixa a cena cuidar da foto!
  if (ctx.session?.__scenes?.current) return;

  // 1. Verifica se quem mandou a foto é Admin
  const admins = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(",") : [];
  if (!admins.includes(ctx.from.id.toString())) return;

  const loadingMsg = await ctx.reply("⏳ Transformando imagem em Link URL permanente...");

  try {
    // 2. Pega o ID da foto com maior resolução enviada
    const fotoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    
    // 3. Pega o link temporário interno do Telegram
    const fileLink = await ctx.telegram.getFileLink(fotoId);

    // 4. Usa 'arraybuffer' para baixar a foto inteira pra memória (resolve o bug do Telegra.ph)
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

    // 5. Prepara o formulário convertendo o Buffer da memória
    const form = new FormData();
    form.append("file", Buffer.from(response.data), "banner.jpg");

    // 6. Faz o Upload direto pra nuvem
    const upload = await axios.post("https://telegra.ph/upload", form, {
        headers: form.getHeaders(),
    });

    // 7. Monta o link final e devolve pro Admin
    if (upload.data && upload.data[0] && upload.data[0].src) {
        const urlFinal = `https://telegra.ph${upload.data[0].src}`;
        
        await ctx.reply(`✅ **Link Gerado com Sucesso!**\n\nCopie o link abaixo e use no cadastro de filmes ou na troca de banners:\n\n\`${urlFinal}\`\n\n*(Toque no link acima para copiar direto)*`, { parse_mode: "Markdown" });
    } else {
        throw new Error("Erro na resposta do Telegraph");
    }
  } catch (err) {
    console.error("❌ Erro ao gerar link de foto:", err.message);
    await ctx.reply("❌ Não foi possível processar a imagem. Tente novamente com outra foto.");
  } finally {
    // Apaga a mensagem de "carregando"
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
  }
});

// Automação via Canal Privado
// Formato FILME:    TITULO | CATEGORIA | PREÇO | URL_POSTER
// Formato EPISÓDIO: EP | SERIE_ID | NUM_EP | TITULO_EP | (BUNNY_URL opcional)
bot.on("channel_post", async (ctx) => {
  const video = ctx.channelPost.video;
  const caption = ctx.channelPost.caption;

  if (!video || !caption || !caption.includes("|")) return;

  const partes = caption.split("|").map((i) => i.trim());
  const admins = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(",") : [];

  try {
    // --- MODO EPISÓDIO: EP | SERIE_ID | NUM_EP | TITULO_EP | (BUNNY_URL opcional) ---
    if (partes[0].toUpperCase() === "EP") {
      const [, serieId, numEpStr, tituloEp, bunnyUrlEp] = partes;
      const numEp = parseInt(numEpStr) || 1;
      const bunnyFinal = (bunnyUrlEp && bunnyUrlEp.startsWith("http")) ? bunnyUrlEp : null;

      // Valida que a série existe
      const { rows: serieRows } = await pool.query('SELECT nm_titulo FROM "CONTEUDOS" WHERE cd_conteudo = $1 LIMIT 1', [serieId]);
      const serie = serieRows[0];

      if (!serie) {
        for (const adminId of admins) {
          await bot.telegram.sendMessage(adminId, `❌ [CANAL EP] Série com ID \`${serieId}\` não encontrada.`, { parse_mode: "Markdown" }).catch(() => {});
        }
        return;
      }

      await pool.query(
        `INSERT INTO "EPISODIOS" (cd_conteudo, nr_episodio, nm_titulo, ds_file_id_telegram, ds_url_bunny) VALUES ($1, $2, $3, $4, $5)`,
        [serieId, numEp, tituloEp || `Episódio ${numEp}`, video.file_id, bunnyFinal]
      );

      for (const adminId of admins) {
        await bot.telegram.sendMessage(
          adminId,
          `📺 **EP ${numEp} CADASTRADO!**\n\nSérie: *${serie.nm_titulo}*\nTítulo: *${tituloEp}*\nBunny: ${bunnyFinal || "Não configurado"}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }

      // 🔔 Avisa quem já tá assistindo essa série
      notificarNovoEpisodio(serieId, numEp, tituloEp || `Episódio ${numEp}`).catch(() => {});
      return;
    }

    // --- MODO FILME/CONTEÚDO: TITULO | CATEGORIA | PREÇO | URL_POSTER ---
    const [titulo, categoria, precoStr, poster] = partes;
    await pool.query(
      `INSERT INTO "CONTEUDOS" (nm_titulo, nm_categoria, vl_aluguel, vl_vitalicio, ds_url_poster, ds_file_id_telegram, tp_fonte_prioritaria, sn_destaque)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        titulo,
        categoria,
        parseFloat(precoStr) || 0,
        (parseFloat(precoStr) || 0) * 2.5,
        poster,
        video.file_id,
        "TELEGRAM",
        false
      ]
    );

    catalogCache.data = null;

    for (const adminId of admins) {
      await bot.telegram.sendMessage(
        adminId,
        `🚀 **NOVO CADASTRO AUTOMÁTICO:**\n\n🎬 *${titulo}* adicionado com sucesso via canal!`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  } catch (e) {
    console.error("❌ [ERRO CANAL AUTOMAÇÃO]:", e.message);
  }
});

// =================================================================
// 🛡️ SISTEMA DE CONCILIAÇÃO BANCÁRIA (O VARREDOR AUTOMÁTICO)
// =================================================================
setInterval(async () => {
    try {
        const agora = new Date();
        // Busca vendas PENDENTES criadas nas últimas 24 horas (para não sobrecarregar o servidor)
        const limiteTempo = new Date(agora.getTime() - (24 * 60 * 60 * 1000)).toISOString();

        const { rows: pendentes } = await pool.query(
            `SELECT v.*, p.nr_dias_validade AS "planoDiasValidade"
             FROM "VENDAS" v
             LEFT JOIN "PLANOS" p ON p.cd_plano = v.cd_plano
             WHERE v.tp_status = $1 AND v.ts_criacao >= $2`,
            ["PENDENTE", limiteTempo]
        );

        if (!pendentes || pendentes.length === 0) return;

        for (const venda of pendentes) {
            if (!venda.ds_txid) continue;

            // Pergunta direto para o Banco Efí o status do TXID
            const infoPix = await efiService.consultarPix(venda.ds_txid);

            // Se o cliente pagou e fechou o app (Webhook falhou), o varredor conserta!
            if (infoPix && infoPix.status === "CONCLUIDA") {
                console.log(`🧹 [VARREDOR] Pagamento recuperado com sucesso! TXID: ${venda.ds_txid}`);

                const type = venda.tp_compra;
                let diasValidade = type === "ALUGUEL" ? 7 : type === "VITALICIO" ? 18250 : 30;
                
                if (type === "ASSINATURA" && venda.planoDiasValidade) {
                    diasValidade = venda.planoDiasValidade;
                }

                const ts_expiracao = new Date();
                ts_expiracao.setDate(ts_expiracao.getDate() + diasValidade);

                // Aprova a venda no banco
                await pool.query(
                    'UPDATE "VENDAS" SET tp_status = $1, ts_expiracao = $2 WHERE cd_venda = $3',
                    ["APROVADA", ts_expiracao.toISOString(), venda.cd_venda]
                );

                catalogCache.data = null; // Ranking reflete nova venda em tempo real

                // Avisa o cliente (ele vai receber a notificação no Telegram mesmo com o app fechado)
                await bot.telegram.sendMessage(
                    venda.nr_id_telegram,
                    "🎉 **PAGAMENTO CONFIRMADO!**\n\nSeu acesso Premium foi liberado. Aproveite! 🍿",
                    {
                        parse_mode: "Markdown",
                        reply_markup: { inline_keyboard: [[{ text: "🚀 ABRIR MELREELS", web_app: { url: process.env.WEBAPP_URL } }]] }
                    }
                ).catch(() => {});
            }
        }
    } catch (err) {
        console.error("❌ Erro no Varredor Automático:", err.message);
    }
}, 2 * 60 * 1000); // Roda exatamente a cada 2 minutos (120.000 ms)

// =================================================================
// 5. INICIALIZAÇÃO SERVER
// =================================================================

async function startBot(retries = 0) {
  try {
    console.log(`🤖 [BOT] Configurando webhook do Telegram (Tentativa #${retries + 1})...`);
    const webhookUrl = `${PUBLIC_DOMAIN}${BOT_WEBHOOK_PATH}`;
    await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
    console.log(`✅ [BOT] Webhook do Telegram configurado: ${PUBLIC_DOMAIN}/telegraf-webhook/***`);
  } catch (err) {
    console.error(`❌ [BOT] Erro ao configurar webhook do Telegram:`, err.message || err);
    const nextRetryDelay = Math.min(10000 * Math.pow(1.5, retries), 60000); // Backoff exponencial, max 60s
    console.log(`⏳ [BOT] Tentando novamente em ${Math.round(nextRetryDelay / 1000)}s...`);
    setTimeout(() => startBot(retries + 1), nextRetryDelay);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n============================================`);
  console.log(`🚀 [MELREELS CORE] Online na porta ${PORT}`);
  console.log(`📡 [STATUS] Escutando conexões web e webhooks...`);
  console.log(`============================================\n`);
  startBot();
});
process.on("uncaughtException", (err) => {
  console.error("🔥 [CRASH] Erro Crítico não tratado:", err.message);
  process.exit(1); // Mata o processo imediatamente para o PM2 reiniciar
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 [CRASH] Promise Rejeitada não tratada:", reason);
  process.exit(1); // Mata o processo imediatamente para o PM2 reiniciar
});

// Graceful shutdown (bot roda em modo webhook, não há polling para parar)
process.once("SIGINT", () => {
  console.log("🛑 Desligando servidor (SIGINT)...");
  process.exit(0);
});
process.once("SIGTERM", () => {
  console.log("🛑 Desligando servidor (SIGTERM)...");
  process.exit(0);
});