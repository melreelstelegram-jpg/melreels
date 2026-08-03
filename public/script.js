/* =================================================================
   MELREELS - SCRIPT OFICIAL DO MINI APP (Aprimorado)
   ================================================================= */

const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Configura cor de fundo do Telegram para bater com o App
tg.setHeaderColor("#000000");
tg.setBackgroundColor("#000000");

let fullCatalog = [];
let currentPixCode = "";
let userId = 0;
let sliderInterval;
let userHistory = [];
let progressInterval = null;
let paymentPollingInterval;
let userStatusData = null;
let currentHls = null;
let userPurchasedIds = [];
let baseCategoryItems = [];
let currentCategoryItems = []; // Guarda a lista atual filtrada
let currentPage = 1;           // Página atual
const itemsPerPage = 15;       // Quantos filmes mostrar por vez (15 = 5 linhas de 3 colunas)

// --- 1. IDENTIFICAÇÃO DO USUÁRIO (BLINDADA PARA IOS) ---
function updateUserId() {
    let id = tg.initDataUnsafe?.user?.id;
    
    if (!id && tg.initData) {
        try {
            const urlParams = new URLSearchParams(tg.initData);
            const userRaw = urlParams.get("user");
            if (userRaw) id = JSON.parse(userRaw).id;
        } catch (e) {}
    }

    if (!id || id === 0) id = localStorage.getItem("melreels_user_id");

    if (id && id !== "undefined" && id !== "null") {
        userId = parseInt(id, 10);
        if (isNaN(userId)) userId = 0; // Trata erro caso a memória do iOS devolva 'NaN'
        else try { localStorage.setItem("melreels_user_id", userId); } catch(e){} 
    } else {
        userId = 0;
    }
    
    return userId; 
}

// --- 2. CARREGAMENTO DE DADOS ---
async function init() {
  updateUserId();
  try {
    await fetchUserStatus();

    // 🚀 PUXA A LISTA DO QUE O CLIENTE JÁ TEM ANTES DE PINTAR A TELA
    if (userId !== 0) {
        try {
            const resMy = await fetch(`/api/my-contents?userId=${userId}`);
            const dataMy = await resMy.json();
            userPurchasedIds = dataMy.map(i => i.cd_conteudo);
            
            const resHist = await fetch(`/api/historico?userId=${userId}&_t=${Date.now()}`);
            userHistory = await resHist.json();
        } catch(e) {}
    }
	
	

    const res = await fetch("/api/catalog");
    fullCatalog = await res.json();
    renderHome();

    // 🎯 O PULO DO GATO: Checa se tem um filme específico na URL (Deep Link)
    const urlParams = new URLSearchParams(window.location.search);
    const movieId = urlParams.get("movie");
    
    if (movieId) {
        setTimeout(() => {
            openMovieDetails(movieId);
        }, 300);
    }

    document.getElementById("app-loader").style.opacity = "0";
    setTimeout(() => (document.getElementById("app-loader").style.display = "none"), 300);
	
	setInterval(() => sendHeartbeat(), 30000);
    sendHeartbeat();

    // 🚀 Timer para exibir o banner flutuante de upsell após 45s
    setTimeout(() => {
        if (!userStatusData || !userStatusData.isVip) {
            mostrarBannerFlutuanteUpsell();
        }
    }, 45000);

  } catch (e) {
    console.error("Erro ao carregar catálogo inicial", e);
    fullCatalog = [];
    document.getElementById("app-loader").innerHTML = "<p>Erro ao conectar ao servidor.</p>";
  }
}

// 🚀 NOVA FUNÇÃO GLOBAL: Verifica se o filme tá liberado (Com Sinônimos e Vírgulas)
function isItemUnlocked(item) {
    if (!item) return false;
    if (userPurchasedIds.includes(item.cd_conteudo)) return true;
    
    if (userStatusData && userStatusData.isVip) {
        const catPlano = (userStatusData.categoria || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const catFilme = (item.nm_categoria || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        
        if (catPlano === 'todas') return true;
        
        // 🧠 Inteligência de Sinônimos (Trata erros de digitação e gêneros)
        if (catPlano.includes('asiatica') && catFilme.includes('dorama')) return true;
        if (catPlano.includes('dorama') && catFilme.includes('asiatica')) return true;
        if (catPlano.includes('americano') && catFilme.includes('americana')) return true;
        if (catPlano.includes('americana') && catFilme.includes('americano')) return true;

        // 🧠 Suporte a múltiplas categorias (Ex: "Americana, Turco, Brasileiro")
        const categoriasDoPlano = catPlano.split(',').map(c => c.trim());
        if (categoriasDoPlano.some(c => catFilme === c)) return true;
    }
    return false;
}

// --- 3. RENDERIZAÇÃO DA HOME (ESTILO NETFLIX + TOP 12) ---
function renderHome() {
    const homeContainer = document.getElementById("home");
    document.getElementById("search-input").value = "";
    if(document.getElementById("category-page")) document.getElementById("category-page").style.display = "none";

    // Pega todo o Top 12 ordenado
    const allTopItems = fullCatalog
        .filter(i => i.rank_top > 0)
        .sort((a, b) => a.rank_top - b.rank_top)
        .slice(0, 12);

    homeContainer.innerHTML = `
        <div style="display: flex; overflow-x: auto; gap: 10px; padding: 0 15px 15px; scrollbar-width: none; -webkit-overflow-scrolling: touch; margin-top: -5px;">
            <div class="chip" onclick="openCategoryPage('Filme')" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);">Filmes</div>
            <div class="chip" onclick="openCategoryPage('Série')" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);">Séries</div>
            <div class="chip" onclick="openCategoryPage('Dorama')" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);">Doramas</div>
            <div class="chip" onclick="openCategoryPage('Short')" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);">Shorts</div>
            <div class="chip" onclick="openCategoryPage('Animação')" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);">Animes</div>
        </div>

        <div style="position: relative;">
            <div class="hero-slider" id="hero-slider"></div>
            <div class="slider-dots" id="slider-dots"></div>
        </div>

        <div class="section-header">
            <span>TOP 12 <i class="fas fa-fire" style="color: var(--main-red);"></i></span>
            <div class="nav-arrows" style="display: flex; gap: 15px; color: var(--text-gray); font-size: 18px;">
                <i class="fas fa-chevron-left" onclick="document.getElementById('top-12-grid').scrollBy({left: -250, behavior: 'smooth'})" style="cursor: pointer;"></i>
                <i class="fas fa-chevron-right" onclick="document.getElementById('top-12-grid').scrollBy({left: 250, behavior: 'smooth'})" style="cursor: pointer;"></i>
            </div>
        </div>
        
        <div class="top12-grid" id="top-12-grid"></div>

        ${generateSectionHTML('Lançamentos')}
        ${generateSectionHTML('Dublados')}
        ${generateSectionHTML('Asiáticos', 'Dramas Asiáticos')} ${generateSectionHTML('Brasileiras')}
        ${generateSectionHTML('Short', 'Reels & Shorts')}
        ${generateSectionHTML('Masculino', 'Público Masculino')}
        ${generateSectionHTML('Animação', 'Animes & IA')}
    `;

    // 1. Destaques (Carrossel)
    renderSlider(fullCatalog.filter(i => i.sn_destaque));

    // 2. Renderiza TODOS os 12 filmes na grade
    renderTop12("top-12-grid", allTopItems);

	// 🚀 LÓGICA DO CONTINUAR ASSISTINDO
    if (userHistory && userHistory.length > 0) {
        let historyHtml = `
            <div class="section-header" style="margin-top: 15px;">
                <span><i class="fas fa-play" style="color: var(--main-red); margin-right: 5px;"></i> Continuar Assistindo</span>
            </div>
            <div class="horizontal-scroll" id="continue-row">
        `;

        historyHtml += userHistory.map(h => {
            const progresso = Math.min((h.nr_tempo_atual / h.nr_tempo_total) * 100, 100);
            const titulo = h.CONTEUDOS?.nm_titulo || "Desconhecido";
            const isSerie = h.cd_episodio ? true : false;
            
            return `
                <div class="card-continue" onclick="assistir('${h.cd_conteudo}', '${titulo}', '${h.cd_episodio || ''}')">
                    <img src="${h.CONTEUDOS?.ds_url_poster}">
                    <div class="continue-info">
                        <div class="title">${titulo}</div>
                        <div class="ep-info">${isSerie ? 'Retomar Série' : 'Retomar Filme'}</div>
                        <div class="progress-bg">
                            <div class="progress-bar" style="width: ${progresso}%"></div>
                        </div>
                    </div>
                </div>
            `;
        }).join("");
        
        historyHtml += `</div>`;
        homeContainer.insertAdjacentHTML('beforeend', historyHtml);
    }
	
    // 3. Lógica Blindada de Lançamentos 
    const lancamentos = [...fullCatalog].sort((a, b) => {
        const dataA = a.dt_lancamento ? new Date(a.dt_lancamento) : new Date(0);
        const dataB = b.dt_lancamento ? new Date(b.dt_lancamento) : new Date(0);
        return dataB - dataA;
    }).slice(0, 12);

    // 4. Populando as fileiras (Carrosséis menores)
    renderRow("lançamentos-row", lancamentos, false);
    renderRow("dublados-row", fullCatalog.filter(i => i.nm_idioma?.toLowerCase().includes("dublado")).slice(0,12), false);
    
    // 🚀 INTELIGÊNCIA DA NOVA FILEIRA DE ASIÁTICOS
    const asiaticos = fullCatalog.filter(i => {
        const cat = (i.nm_categoria || "").toLowerCase();
        const gen = (i.ds_generos || "").toLowerCase();
        return cat.includes("asiat") || gen.includes("asiat") || cat.includes("dorama") || gen.includes("dorama") || cat.includes("corean") || gen.includes("corean");
    }).slice(0,12);
    renderRow("asiáticos-row", asiaticos, false);

    renderRow("brasileiras-row", fullCatalog.filter(i => i.ds_generos?.toLowerCase().includes("brasil")).slice(0,12), false);
    renderRow("short-row", fullCatalog.filter(i => i.nm_categoria === "Short" || i.ds_generos?.includes("Short")).slice(0,12), false);
    renderRow("masculino-row", fullCatalog.filter(i => i.ds_generos?.toLowerCase().includes("masculino")).slice(0,12), false);
    
    const iaAnimes = fullCatalog.filter(i => {
        const cat = (i.nm_categoria || "").toLowerCase();
        const gen = (i.ds_generos || "").toLowerCase();
        return cat.includes("anima") || gen.includes("anima") || cat.includes("ia") || gen.includes("i.a");
    }).slice(0,12);
    renderRow("animação-row", iaAnimes, false);
}
// 🚀 1. Função que avisa o servidor que o usuário está online
async function sendHeartbeat(conteudoId = null) {
    if (!userId || userId === 0) return;
    
    try {
        await fetch("/api/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                nr_id_telegram: userId, 
                cd_conteudo: conteudoId,
                dispositivo: tg.platform || "Desconhecido" // Ex: 'ios', 'android', 'tdesktop'
            })
        });
    } catch (e) { console.log("Erro no heartbeat"); }
}

function renderTop12(containerId, items) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!items || !items.length) {
        container.innerHTML = `<div style="grid-column: span 2; text-align: center; color: gray; font-size: 12px;">Em breve...</div>`;
        return;
    }

    container.innerHTML = items.map((item, index) => {
        const rank = index + 1;
        let badgeClass = 'rank-other';
        if (rank === 1) badgeClass = 'rank-1';
        else if (rank === 2) badgeClass = 'rank-2';
        else if (rank === 3) badgeClass = 'rank-3';

        // 🚀 VERIFICA SE O CLIENTE TEM ACESSO
        const liberado = isItemUnlocked(item);
        
        // 🚀 MUDA A COR E O TEXTO DO BOTÃO DINAMICAMENTE
        const btnColor = liberado ? "background: #00ff41; color: black;" : "background: white; color: black;";
        const btnIcon = liberado ? "fa-play" : "fa-dollar-sign";
        const btnText = liberado ? "ASSISTIR" : "COMPRAR";

        return `
            <div class="card-top12">
                <div class="card-top12-img-container">
                    <img src="${item.ds_url_poster}" loading="lazy" onclick="openMovieDetails('${item.cd_conteudo}')">
                    <div class="top12-badge ${badgeClass}">${rank}</div>
                </div>
                
                <div class="card-top12-info">
                    <div class="card-top12-title">${item.nm_titulo}</div>
                    <div class="card-top12-price">R$ ${parseFloat(item.vl_aluguel).toFixed(2).replace('.', ',')}</div>
                    
                    <button class="btn-top12-buy" onclick="openMovieDetails('${item.cd_conteudo}')" style="${btnColor}">
                        <i class="fas ${btnIcon}"></i> ${btnText}
                    </button>
                </div>
            </div>
        `;
    }).join("");
}

// Função auxiliar para não repetir código de cabeçalho
function generateSectionHTML(id, label) {
    const displayLabel = label || id;
    const rowId = id.toLowerCase().replace(' ', '-') + "-row";
    return `
        <div class="section-header">
            <span>${displayLabel}</span>
            <div class="ver-tudo" onclick="openCategoryPage('${id}')">Ver tudo <i class="fas fa-chevron-right"></i></div>
        </div>
        <div class="horizontal-scroll" id="${rowId}"></div>
    `;
}

function renderRow(containerId, items, showRank) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!items || !items.length) {
        container.innerHTML = `<div style="padding: 0 15px; color: gray; font-size: 12px;">Em breve novos conteúdos...</div>`;
        return;
    }

    container.innerHTML = items.map(item => {
        // 🚀 VERIFICA SE O CLIENTE TEM ACESSO (Pinta de verde o de Detalhes também!)
        const liberado = isItemUnlocked(item);
        const btnStyle = liberado ? "background: #00ff41; color: black;" : "background: rgba(255, 255, 255, 0.15); color: white;";
        const btnIcon = liberado ? "fa-play" : "fa-plus";
        const btnText = liberado ? "ASSISTIR" : "DETALHES";

        return `
        <div class="card-mini" style="${showRank ? 'margin-left: 20px;' : ''}"> 
            <div style="position:relative">
                <img src="${item.ds_url_poster}" 
                     loading="lazy" 
                     onclick="openMovieDetails('${item.cd_conteudo}')"
                     style="cursor: pointer;">
                
                ${showRank ? `<div class="rank-number">${item.rank_top}</div>` : ""}
            </div>
            
            <div class="title">${item.nm_titulo}</div>
            <div class="price">R$ ${parseFloat(item.vl_aluguel).toFixed(2).replace('.', ',')}</div>
            
            <button class="btn-buy-small" onclick="openMovieDetails('${item.cd_conteudo}')" style="${btnStyle}">
                <i class="fas ${btnIcon}"></i> ${btnText}
            </button>
        </div>
        `;
    }).join("");
}

// CORRIGIDO: A função agora está fechada corretamente
function renderSlider(items) {
  const container = document.getElementById("hero-slider");
  const dotsContainer = document.getElementById("slider-dots");
  if (!items.length) return;

  container.innerHTML = items
    .map(
      (item) => `
        <div class="hero-item" style="background-image: url('${item.ds_url_poster}')">
            <div class="hero-overlay" style="padding-bottom: 35px;">
                <button onclick="openMovieDetails('${item.cd_conteudo}')" style="margin: 0 auto; width: 85%; max-width: 250px; background: var(--main-red); color: white;">
                    <i class="fas fa-shopping-cart"></i> COMPRAR
                </button>
            </div>
        </div>
    `,
    )
    .join("");

    // Cria as bolinhas (dots)
  if (dotsContainer) {
    dotsContainer.innerHTML = items
      .map((_, i) => `<div class="dot ${i === 0 ? "active" : ""}"></div>`)
      .join("");
  }

  // Lógica de rotação automática do slider
  clearInterval(sliderInterval);
  let currentIndex = 0;
  sliderInterval = setInterval(() => {
    currentIndex = (currentIndex + 1) % items.length;
    const scrollAmount = container.clientWidth * currentIndex;
    container.scrollTo({ left: scrollAmount, behavior: "smooth" });

    // Atualiza as bolinhas
    const dots = document.querySelectorAll(".dot");
    dots.forEach((dot, index) => {
      dot.classList.toggle("active", index === currentIndex);
    });
  }, 4000); 
}

async function openMovieDetails(id) {
    const item = fullCatalog.find(i => i.cd_conteudo === id);
    if(!item) return;

    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("medium");

    // Preenche os dados
    document.getElementById("details-banner").style.backgroundImage = `url('${item.ds_url_poster}')`;
    document.getElementById("details-poster").src = item.ds_url_poster;
    document.getElementById("details-title").innerText = item.nm_titulo;
    document.getElementById("details-year").innerText = item.dt_lancamento ? new Date(item.dt_lancamento).getFullYear() : '2026';
    document.getElementById("details-duration").innerText = `${item.nr_duracao_minutos || '--'} min`;
    document.getElementById("details-format").innerText = item.tp_formato || 'Filme';
    document.getElementById("details-synopsis").innerText = item.ds_descricao || 'Sem sinopse disponível.';

    // Referências dos Botões
    const btnBuyNow = document.getElementById("btn-main-buy");
    const episodesContainer = document.getElementById("episodes-container");
    const btnPreview = document.getElementById("btn-preview");

    // Garante que o botão principal sempre volte a aparecer (pode ter sido ocultado antes)
    btnBuyNow.style.display = "flex"; 

    // 🚀 LÓGICA DO BOTÃO DE PRÉVIA (TRAILER YOUTUBE)
    if (item.ds_url_trailer_youtube && item.ds_url_trailer_youtube.length > 5) {
        btnPreview.style.display = "flex";
        btnPreview.onclick = () => {
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
            
            let linkTrailer = item.ds_url_trailer_youtube.includes("http") 
                ? item.ds_url_trailer_youtube 
                : `https://www.youtube.com/watch?v=${item.ds_url_trailer_youtube}`;
                
            tg.openLink(linkTrailer); 
        };
    } else {
        btnPreview.style.display = "none";
    }

    // 🎯 1. CHECA SE O CLIENTE JÁ TEM ACESSO (Pagou ou é VIP)
    let hasAccess = false;
    if (userId !== 0) {
        const checkRes = await fetch(`/api/check-payment?userId=${userId}&contentId=${id}`);
        const checkData = await checkRes.json();
        
        hasAccess = checkData.approved; 
        
        // Aplica a inteligência de sinônimos local, caso exista a função
        if (!hasAccess && typeof isItemUnlocked === "function") {
            hasAccess = isItemUnlocked(item);
        }
    }

    if (hasAccess) {
        // =======================================================
        // 🟢 MODO LIBERADO: Adaptação Inteligente de Interface
        // =======================================================
        
        if (item.tp_formato === 'SERIE') {
            // 🎬 1. SÉRIES: Oculta o botão "Assistir" para não confundir e mostra os episódios
            btnBuyNow.style.display = "none"; 
            episodesContainer.style.display = "block";
            document.getElementById("episodes-list").innerHTML = "<p style='color: gray; font-size: 12px; text-align:center;'>Carregando episódios...</p>";
            
            try {
                const epRes = await fetch(`/api/episodes?conteudoId=${id}`);
                const episodios = await epRes.json();
                
                if (episodios.length === 0) {
                    document.getElementById("episodes-list").innerHTML = "<p style='color: gray; font-size: 12px; text-align:center;'>Nenhum episódio liberado ainda.</p>";
                } else {
                    // Aviso elegante + Lista de Episódios chamando a função universal!
                    let htmlSaga = `
                        <div style="text-align: center; color: #aaa; font-size: 13px; margin-bottom: 15px; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px;">
                            👇 Selecione um episódio abaixo para receber no seu Telegram
                        </div>
                    `;
                    
                    htmlSaga += episodios.map(ep => `
                        <div onclick="entregarPeloBot('${id}', '${ep.cd_episodio}')" 
                             style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; justify-content: space-between; cursor: pointer; margin-bottom: 10px;">
                            <div>
                                <div style="color: #aaa; font-size: 10px; font-weight: 800; letter-spacing: 1px; margin-bottom: 4px;">EPISÓDIO ${ep.nr_episodio}</div>
                                <div style="color: white; font-size: 14px; font-weight: 700;">${ep.nm_titulo}</div>
                            </div>
                            <div style="background: #25D366; width: 35px; height: 35px; border-radius: 50%; display:flex; align-items:center; justify-content:center;">
                                <i class="fab fa-telegram-plane" style="color: white; font-size: 14px;"></i>
                            </div>
                        </div>
                    `).join("");
                    
                    document.getElementById("episodes-list").innerHTML = htmlSaga;
                }
            } catch(e) {
                 document.getElementById("episodes-list").innerHTML = "<p style='color: red; font-size: 12px; text-align:center;'>Erro ao carregar episódios.</p>";
            }

        } else if (item.tp_fonte_prioritaria === 'TELEGRAM') {
            // ✈️ 2. FILMES NO TELEGRAM: Botão Verde que envia direto pro chat!
            episodesContainer.style.display = "none";
            btnBuyNow.innerHTML = `<i class="fab fa-telegram-plane" style="margin-right: 6px;"></i> RECEBER NO CHAT`;
            btnBuyNow.style.background = "#25D366"; 
            btnBuyNow.style.color = "white";
            btnBuyNow.style.justifyContent = "center";
            btnBuyNow.onclick = () => entregarPeloBot(item.cd_conteudo); // Função universal sem passar episódio

        } else {
            // ▶️ 3. FILMES LOCAL/BUNNY: Abre no Web Player interno normalmente
            episodesContainer.style.display = "none";
            btnBuyNow.innerHTML = `<i class="fas fa-play"></i> ASSISTIR AGORA`;
            btnBuyNow.style.background = "#00ff41"; 
            btnBuyNow.style.color = "black";
            btnBuyNow.style.justifyContent = "center";
            btnBuyNow.onclick = () => assistir(item.cd_conteudo, item.nm_titulo);
        }

    } else {
        // =======================================================
        // 🔴 MODO BLOQUEADO: Botão de Compra
        // =======================================================
        btnBuyNow.innerHTML = `<i class="fas fa-shopping-cart"></i> COMPRAR`;
        btnBuyNow.style.background = "var(--main-red, #E50914)";
        btnBuyNow.style.color = "white";
        btnBuyNow.style.justifyContent = "center";
        btnBuyNow.onclick = () => {
            abrirOpcoes(item.cd_conteudo, item.nm_titulo, item.vl_aluguel, item.vl_vitalicio);
        };
        episodesContainer.style.display = "none";
    }

    // Botão Compartilhar
    document.getElementById("btn-share").onclick = () => {
        const botInfo = tg.initDataUnsafe?.receiver || { username: "Melreels_bot" }; 
        const shareLink = `https://t.me/${botInfo.username}?start=${item.cd_conteudo}`;
        const el = document.createElement("textarea");
        el.value = shareLink;
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
        tg.showAlert("🔗 Link copiado! Envie para seus amigos.");
    };

    // Alterna visibilidade da tela
    document.querySelectorAll(".container").forEach(c => c.style.display = "none");
    document.getElementById("movie-details").style.display = "block";
}
function backToHome() {
    document.getElementById("movie-details").style.display = "none";
    switchTab('home'); // Agora o switchTab vai conseguir reexibir a home!
}

// Normaliza string removendo acentos para busca mais ampla
function normStr(s) {
  return (s || '').toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// --- 4. BUSCA EM TEMPO REAL (GLOBAL) ---
let _searchTimer = null;
function filterCatalog() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(_doFilter, 250); // debounce 250ms para celulares lentos
}
function _doFilter() {
  const input = document.getElementById("search-input");
  const rawTerm = input.value;
  const term = normStr(rawTerm);
  const home = document.getElementById("home");
  const clearBtn = document.getElementById("clear-search");

  if (term.length > 0) {
    clearBtn.style.display = "block";

    // 🚀 A MÁGICA: Se o cliente estiver em outra aba, esconde ela e força a exibição da tela de busca!
    document.querySelectorAll(".container").forEach(c => {
        c.classList.remove("active", "fade-in");
        c.style.display = "none"; // Esconde Minha Lista, Premium, etc.
    });
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    
    // Mostra a Home (onde a busca acontece) e acende o ícone no rodapé
    home.style.display = "block";
    home.classList.add("active", "fade-in");
    document.getElementById("nav-home").classList.add("active");

    // Filtra o catálogo global — busca por título, categoria e gênero, sem sensibilidade a acentos
    const filtered = fullCatalog.filter((i) =>
      normStr(i.nm_titulo).includes(term) ||
      normStr(i.nm_categoria).includes(term) ||
      normStr(i.ds_generos).includes(term)
    );

    // Constrói o grid de resultados
    home.innerHTML = `<div class="section-title" style="padding: 15px;">Resultados para: "${term}"</div><div class="grid" id="search-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; padding: 15px;"></div>`;
    const grid = document.getElementById("search-grid");
    
    if (filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column: span 2; text-align: center; color: var(--text-gray); margin-top: 20px;">Nenhum título encontrado.</div>`;
    } else {
      grid.innerHTML = filtered
        .map(
          (item) => `
            <div class="card-premium-list">
                <img src="${item.ds_url_poster}" onclick="openMovieDetails('${item.cd_conteudo}')" style="width: 100%; height: 240px; object-fit: cover; border-radius: 12px; cursor: pointer;">
                <div class="card-premium-overlay" style="position: absolute; bottom: 0; width: 100%; background: linear-gradient(to top, rgba(0,0,0,0.9), transparent); padding: 10px; display: flex; flex-direction: column; justify-content: flex-end;">
                    <div class="premium-title" style="color: white; font-size: 12px; font-weight: bold; margin-bottom: 5px;">${item.nm_titulo}</div>
                    <button class="btn-buy-small" onclick="openMovieDetails('${item.cd_conteudo}')" style="width: 100%; padding: 8px; background: rgba(255,255,255,0.15); color: white; border: none; border-radius: 6px; font-weight: bold;">
                        DETALHES
                    </button>
                </div>
            </div>
        `
        )
        .join("");
    }
  } else {
    // Se o cliente apagar todo o texto na mão, limpa a busca.
    clearSearch();
  }
}

function clearSearch() {
  clearTimeout(_searchTimer); // Cancela qualquer busca pendente no debounce
  document.getElementById("search-input").value = "";
  document.getElementById("clear-search").style.display = "none";

  // Remonta os trilhos da Home (Top 12, Lançamentos...)
  if (document.getElementById("home").classList.contains("active")) {
      renderHome();
  }
}


// Abre a página de catálogo completo
function openCategoryPage(title) {
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("medium");
    document.getElementById("category-page-title").innerText = title;
    
    document.querySelectorAll(".container").forEach((c) => c.classList.remove("active"));
    const target = document.getElementById("category-page");
    target.style.display = "block";
    target.classList.add("active");

    let items = fullCatalog;
    const termo = title.toLowerCase();

    // Filtros à prova de letras maiúsculas/minúsculas
    if (title === 'Dublados') {
        items = fullCatalog.filter(i => (i.nm_idioma || '').toLowerCase().includes("dublado"));
    } else if (title === 'Brasileiras') {
        items = fullCatalog.filter(i => (i.ds_generos || '').toLowerCase().includes("brasil"));
    } else if (title === 'Masculino') {
        items = fullCatalog.filter(i => (i.ds_generos || '').toLowerCase().includes("masculino"));
    } else if (title === 'Lançamentos') {
        items = [...fullCatalog].sort((a, b) => {
            const dataA = a.dt_lancamento ? new Date(a.dt_lancamento) : new Date(0);
            const dataB = b.dt_lancamento ? new Date(b.dt_lancamento) : new Date(0);
            return dataB - dataA;
        });
    } else if (title === 'Short') { 
        items = fullCatalog.filter(i => (i.nm_categoria || '').toLowerCase().includes('short') || (i.ds_generos || '').toLowerCase().includes('short'));
    } else if (title === 'Animação') { 
        items = fullCatalog.filter(i => {
            const cat = (i.nm_categoria || "").toLowerCase();
            const gen = (i.ds_generos || "").toLowerCase();
            return cat.includes("anima") || gen.includes("anima") || cat.includes("ia") || gen.includes("i.a");
        });
    } else if (title === 'Asiáticos') { 
        // 🚀 NOVO: Inteligência pro botão "Ver Tudo" da nova fileira!
        items = fullCatalog.filter(i => {
            const cat = (i.nm_categoria || "").toLowerCase();
            const gen = (i.ds_generos || "").toLowerCase();
            return cat.includes("asiat") || gen.includes("asiat") || cat.includes("dorama") || gen.includes("dorama") || cat.includes("corean") || gen.includes("corean");
        });
    } else if (title !== 'Catálogo') {
        items = fullCatalog.filter(i => (i.nm_categoria || '').toLowerCase().includes(termo) || (i.ds_generos || '').toLowerCase().includes(termo));
    }

    // Salva na global, reseta pra página 1 e renderiza a grade
    baseCategoryItems = items; 
    currentPage = 1;
    currentCategoryItems = items;
    renderFullGrid();
}

// Filtro rápido dentro da página de catálogo (Os Chips do Topo)
function filterCategoryPage(tipo) {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    event.target.classList.add('active');

    // 🚀 CORREÇÃO DOS CHIPS: Agora ele filtra DENTRO da categoria atual, e não no banco todo!
    let filtered = baseCategoryItems; 
    
    if(tipo !== 'TODOS') {
        filtered = baseCategoryItems.filter(i => 
            i.tp_formato === tipo || 
            ((i.nm_categoria || '').includes(tipo)) ||
            ((i.ds_generos || '').includes(tipo))
        );
    }
    
    currentPage = 1;
    currentCategoryItems = filtered;
    renderFullGrid();
}

// Renderiza a grade fatiada com paginação
function renderFullGrid() {
    const grid = document.getElementById("category-grid");
    const paginationContainer = document.getElementById("pagination-container");
    
    if (!currentCategoryItems.length) {
        grid.innerHTML = `<div style="grid-column: span 3; text-align: center; padding: 40px; color: gray;">Nenhum conteúdo nesta categoria.</div>`;
        if (paginationContainer) paginationContainer.innerHTML = "";
        return;
    }

    // ✂️ Corta a lista de filmes baseada na página atual
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const itemsToShow = currentCategoryItems.slice(startIndex, endIndex);

    grid.innerHTML = itemsToShow.map(item => `
        <div class="card-mini">
            <img src="${item.ds_url_poster}" onclick="openMovieDetails('${item.cd_conteudo}')" style="cursor: pointer;">
            <div class="title" style="font-size: 10px;">${item.nm_titulo}</div>
            <button class="btn-buy-small" onclick="openMovieDetails('${item.cd_conteudo}')">
                DETALHES
            </button>
        </div>
    `).join("");

    // Chama a função que desenha os botõezinhos no rodapé
    renderPaginationControls();
}

// Desenha os botões << 1 2 3 >>
function renderPaginationControls() {
    const container = document.getElementById("pagination-container");
    if (!container) return;

    const totalPages = Math.ceil(currentCategoryItems.length / itemsPerPage);

    // Se só tiver 1 página, esconde os botões
    if (totalPages <= 1) {
        container.innerHTML = ""; 
        return;
    }

    let html = "";
    
    // Botão Voltar (<<)
    if (currentPage > 1) {
        html += `<button class="page-btn" onclick="goToPage(${currentPage - 1})"><i class="fas fa-chevron-left"></i></button>`;
    }

    // Calcula para não mostrar 50 botões se tiver muita página. Mostra só as próximas.
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) {
        startPage = Math.max(1, endPage - 4);
    }

    // Cria os botões com os números (1, 2, 3...)
    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    }

    // Botão Avançar (>>)
    if (currentPage < totalPages) {
        html += `<button class="page-btn" onclick="goToPage(${currentPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
    }

    container.innerHTML = html;
}

// Função engatilhada quando o cliente clica no botão da página
function goToPage(page) {
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
    currentPage = page;
    renderFullGrid();
    
    // Joga o cliente pro topo da página suavemente para ele ver os novos filmes
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
// clearSearch definido acima (linha única, sem duplicata para evitar loop infinito)

// --- 5. COMPRAS E PIX ---
function abrirOpcoes(id, titulo, precoAluguel, precoVitalicio) {
  if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");

  const modal = document.getElementById("custom-buy-modal");
  
  document.getElementById("buy-modal-desc").innerText = `Como deseja acessar "${titulo}"?`;
  
  const btnVitalicio = document.getElementById("btn-buy-vitalicio");
  const btnAluguel = document.getElementById("btn-buy-aluguel");
  
  // Garante que é número
  const valVitalicio = parseFloat(precoVitalicio) || 0;
  const valAluguel = parseFloat(precoAluguel) || 0;

  btnVitalicio.innerText = `VITALÍCIO: R$ ${valVitalicio.toFixed(2).replace('.', ',')}`;
  btnAluguel.innerText = `ALUGAR (7 DIAS): R$ ${valAluguel.toFixed(2).replace('.', ',')}`;
  
  // Lógica de clique nos botões do modal
  btnVitalicio.onclick = () => {
    fecharModalCompra();
    processarCompra(id, titulo, "VITALICIO", valVitalicio);
  };
  
  btnAluguel.onclick = () => {
    fecharModalCompra();
    processarCompra(id, titulo, "ALUGUEL", valAluguel);
  };
  
  // Mostra o modal de vidro
  modal.style.display = "flex";
}

function fecharModalCompra() {
  document.getElementById("custom-buy-modal").style.display = "none";
}

async function processarCompra(id, titulo, modalidade, valorFinal) {
  if (userId === 0)
    return tg.showAlert("⚠️ Por favor, acesse o app através do Bot oficial para realizar compras.");

  tg.MainButton.setText(`PAGAR R$ ${parseFloat(valorFinal).toFixed(2)}`);
  tg.MainButton.show();
  tg.MainButton.showProgress();

  try {
    const res = await fetch("/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_origem: id, nr_id_telegram: userId, modalidade }),
    });
    const result = await res.json();

    if (result.success) {
      currentPixCode = result.qrCode;
      
      // Reseta as telas do modal
      document.getElementById("qr-code-section").style.display = "block";
      document.getElementById("success-section").style.display = "none";

      const promoBadge = document.getElementById("payment-promo-badge");
      if (promoBadge) promoBadge.style.display = "none";

      document.getElementById("modal-price").innerText = `R$ ${parseFloat(valorFinal).toFixed(2).replace('.', ',')}`;
      document.getElementById("modal-title").innerText = titulo;
      document.getElementById("qr-code-img").src = `data:image/jpeg;base64,${result.qrCodeBase64}`;
      document.getElementById("payment-modal").style.display = "flex";
      
      if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");

      // --- INÍCIO DO POLLING DE VERIFICAÇÃO ---
      clearInterval(paymentPollingInterval);
      paymentPollingInterval = setInterval(async () => {
          try {
              const isPlan = modalidade === "ASSINATURA";
              const param = isPlan ? `planId=${id}` : `contentId=${id}`;
              const resPoll = await fetch(`/api/check-payment?userId=${userId}&${param}`);
              const dataPoll = await resPoll.json();

              if (dataPoll.approved) {
    clearInterval(paymentPollingInterval);
    
    // Atualiza as telas do modal
    document.getElementById("qr-code-section").style.display = "none";
    document.getElementById("success-section").style.display = "block";
    
    // 🚀 AQUI ENTRA A MUDANÇA DO SINO DE NOTIFICAÇÃO:
    // Cria uma bolha com o número "1" em cima do ícone "Minha Lista"
    const navMyList = document.getElementById("nav-mylist");
    if (!document.getElementById("badge-novo")) {
        navMyList.innerHTML += `<div id="badge-novo" class="nav-badge">1</div>`;
    }
    
    // 🎯 AQUI ESTÁ A MUDANÇA:
    // Se for um filme (não plano), o botão de sucesso abre o filme direto
    const btnSucesso = document.querySelector("#success-section button");
    if (!isPlan) {
        btnSucesso.onclick = () => {
            closePaymentModal();
            openMovieDetails(id); // Abre a página do filme comprado!
        };
    } else {
        btnSucesso.onclick = () => {
            closePaymentModal();
            switchTab('home'); // Se for plano, volta pra home liberada
        };
    }

    if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
}
          } catch(e) {}
      }, 3000);
      // --- FIM DO POLLING ---

    } else {
      if (result.interceptedUpsell) {
        tg.showAlert("💡 Preparamos uma oferta especial no seu Telegram!\n\nAbra o chat do bot para ver e prosseguir.", () => {
          tg.close();
        });
      } else {
        tg.showAlert("Erro: " + result.error);
      }
    }
  } catch (e) {
    tg.showAlert("Erro de conexão com o servidor de pagamentos.");
  } finally {
    tg.MainButton.hide();
    tg.MainButton.hideProgress();
  }
}
// --- 6. MINHA LISTA E ASSINATURAS ---
async function loadMyList() {
    const grid = document.getElementById("mylist-grid");
    const empty = document.getElementById("mylist-empty");
    
    // 1. Mostra 4 blocos de carregamento (shimmer) enquanto o fetch não termina
    grid.innerHTML = `
        <div class="loading-shimmer"></div>
        <div class="loading-shimmer"></div>
        <div class="loading-shimmer"></div>
        <div class="loading-shimmer"></div>
    `; 

    try {
        const res = await fetch(`/api/my-contents?userId=${userId}`);
        const data = await res.json();
        
        // (Sua lógica de VIP permanece igual aqui...)
        const usuarioEhVip = data && data.length > 20; 
        if (usuarioEhVip) { 
            document.querySelector("header h1").innerHTML = 'MELREELS <span style="font-size: 16px;">👑</span>';
        }

        if (!data || data.length === 0) {
            empty.style.display = "block";
            grid.innerHTML = "";
        } else {
            empty.style.display = "none";
            grid.innerHTML = data.map(item => `
                <div class="card-premium-list">
                    <img src="${item.ds_url_poster}">
                    <div class="card-premium-overlay">
                        <div class="premium-title">${item.nm_titulo}</div>
                        <button class="btn-premium-watch" onclick="openMovieDetails('${item.cd_conteudo}')">
                            <i class="fas fa-play"></i> ASSISTIR AGORA
                        </button>
                    </div>
                </div>
            `).join("");
        }
    } catch (e) {
        grid.innerHTML = "";
        empty.style.display = "block";
        empty.innerHTML = "<p>Erro ao buscar sua lista.</p>";
    }
}

async function loadPlans() {
  const container = document.getElementById("bestsellers-grid");
  container.innerHTML = `<div class="loading-shimmer" style="height: 150px; border-radius: 10px; margin: 15px;"></div>`;

  try {
    const res = await fetch("/api/plans");
    const planos = await res.json();
    container.style.padding = "0 15px";
    
    let htmlContent = "";

    // SE O CLIENTE FOR VIP, ELE GANHA A CARTEIRINHA DOURADA AQUI NO TOPO!
    if (userStatusData && userStatusData.isVip) {
        const dataVencimento = new Date(userStatusData.expira).toLocaleDateString('pt-BR');
        htmlContent += `
            <div class="vip-card">
                <div class="vip-card-title">👑 ${userStatusData.plano}</div>
                <div class="vip-card-date">Expira em: ${dataVencimento}</div>
                <p style="font-size: 12px; font-weight: 700; opacity: 0.8; margin:0;">Você tem acesso Premium liberado ao conteúdo. Aproveite!</p>
            </div>
            <div class="section-title" style="margin-top: 30px; margin-bottom: 15px; font-size: 14px; text-align: left; color: #aaa;">OUTROS PLANOS DISPONÍVEIS:</div>
        `;
    }

    htmlContent += planos.map(p => `
        <div class="card" style="border: 1px solid var(--main-red); background: linear-gradient(145deg, #111, #1a1a1a); margin-bottom: 20px; border-radius: 15px; padding: 25px; text-align: center; box-shadow: 0 5px 15px rgba(229, 9, 20, 0.1);">
            <div class="card-title" style="font-size: 22px; font-weight: 900; text-transform: uppercase;">💎 ${p.nm_plano}</div>
            <p style="color: #aaa; font-size: 14px; margin: 10px 0;">Acesso total à categoria: <br> <strong style="color: white">${p.nm_categoria}</strong></p>
            <div style="font-size: 32px; font-weight: bold; margin: 15px 0; color: var(--price-green);">R$ ${parseFloat(p.vl_plano).toFixed(2).replace('.', ',')}</div>
            <button class="btn-premium-watch" onclick="assinarPlano('${p.cd_plano}', '${p.nm_plano}', '${p.vl_plano}')">ASSINAR AGORA</button>
        </div>
    `).join("");
    
    container.innerHTML = htmlContent;
  } catch (e) {
    container.innerHTML = "<p style='text-align:center;'>Erro ao carregar os planos.</p>";
  }
}
async function assinarPlano(id, nome, valor) {
  tg.showConfirm(`Deseja confirmar a assinatura do plano ${nome}?`, (ok) => {
    if (ok) processarCompra(id, nome, "ASSINATURA", valor);
  });
}

// --- 7. PLAYER DE VÍDEO ---
// Sempre passa pelo backend (/api/smart-stream) para validação de acesso e cascata automática.
// O HLS é detectado pelos metadados do catálogo (nunca pela URL direta do Bunny).
async function assistir(conteudoId, titulo, episodioId = null) {
    sendHeartbeat(conteudoId);
    const item = fullCatalog.find(i => i.cd_conteudo === conteudoId);

    // Sempre usa o backend — o cascata decide LOCAL/BUNNY/TELEGRAM após validar o acesso
    let streamUrl = `/api/smart-stream?userId=${userId}&cd_conteudo=${conteudoId}`;
    if (episodioId) streamUrl += `&episodioId=${episodioId}`;

    // Detecta HLS apenas pelo tipo de URL cadastrado (sem expor a URL real ao frontend)
    const isBunnyHls = item?.tp_fonte_prioritaria === 'BUNNY' && item?.ds_url_bunny?.includes('.m3u8');

    const player = document.getElementById("main-player");
    const container = document.getElementById("video-player-container");

    document.getElementById("player-title").innerText = titulo;
    container.style.display = "flex";
    tg.expand();
    tg.BackButton.hide();

    container.style.opacity = 0;
    setTimeout(() => (container.style.opacity = 1), 10);

    if (currentHls) { currentHls.destroy(); currentHls = null; }

    // ==========================================
    // 📼 SISTEMA DE CONTINUAR ASSISTINDO (NOVO)
    // ==========================================
    const hist = userHistory.find(h => h.cd_conteudo === conteudoId);
    
    // Assim que o vídeo tiver tamanho e duração lidos, pula pro tempo!
    player.addEventListener('loadedmetadata', function onMeta() {
        // Se já assistiu mais de 5 segundos, pula pro tempo salvo
        if (hist && hist.nr_tempo_atual > 5) {
            player.currentTime = hist.nr_tempo_atual;
        }
    }, { once: true }); // Executa só uma vez pra não bugar se o vídeo travar

    // Inicia o motor que salva o progresso a cada 10 segundos
    clearInterval(progressInterval);
    progressInterval = setInterval(() => {
        if (!player.paused && player.currentTime > 0) {
            fetch("/api/historico", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    nr_id_telegram: userId,
                    cd_conteudo: conteudoId,
                    cd_episodio: episodioId || null,
                    tempo_atual: player.currentTime,
                    tempo_total: player.duration || 100
                })
            }).catch(()=>{}); // Oculta erros de rede
        }
    }, 10000); 
    // ==========================================

    if (isBunnyHls) {
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            currentHls = new Hls();
            currentHls.loadSource(streamUrl);
            currentHls.attachMedia(player);
            currentHls.on(Hls.Events.MANIFEST_PARSED, () => {
                player.play().catch(e => console.log("Autoplay bloqueado", e));
            });
        } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari / iOS suporte nativo a HLS
            player.src = streamUrl;
            
            player.addEventListener('loadedmetadata', () => {
                player.play().catch(e => console.log("Autoplay bloqueado", e));
            }, { once: true });
        }
    } else {
        player.src = streamUrl;
        player.load();
        player.play().catch(e => console.log("Autoplay bloqueado", e));
    }

    if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
    } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
    }

    player.onpause = () => container.classList.add("paused");
    player.onplay = () => container.classList.remove("paused");
    
    player.onended = () => {
        // Exibe o overlay de Upsell Pós-Filme se o usuário não for VIP (sem assinatura ativa)
        if (!userStatusData || !userStatusData.isVip) {
            if (document.fullscreenElement) {
                if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            }
            const upsellOverlay = document.getElementById("upsell-pos-filme");
            if (upsellOverlay) upsellOverlay.style.display = "flex";
        } else {
            closePlayer();
        }
    };
}

function closePlayer() {
    const container = document.getElementById("video-player-container");
    const player = document.getElementById("main-player");

    player.pause();
    
    const upsellOverlay = document.getElementById("upsell-pos-filme");
    if (upsellOverlay) upsellOverlay.style.display = "none";
    
    // Desliga o motor do Bunny para economizar memória do celular
    if (currentHls) {
        currentHls.destroy();
        currentHls = null;
    }
	
	clearInterval(progressInterval);
    
    // Opcional: Atualiza a lista de fundo pra atualizar a barra quando fechar o video
    fetch(`/api/historico?userId=${userId}&_t=${Date.now()}`)
        .then(r => r.json())
        .then(data => { userHistory = data; if(document.getElementById("home").classList.contains("active")) renderHome(); });

    if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }

    container.style.opacity = 0;
    setTimeout(() => {
        container.style.display = "none";
        player.src = ""; 
        player.removeAttribute('src'); // Força a limpeza
    }, 300);
}

// Função direta: Funciona para Séries (com episodioId) ou Filmes (sem episodioId)
async function entregarPeloBot(conteudoId, episodioId = null) {
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("heavy");
    
    const idFresco = updateUserId();
    // Proteção extra contra IDs zumbis do iOS
    if (!idFresco || isNaN(idFresco) || idFresco === 0) {
        tg.showAlert("❌ Erro de Sessão Apple: Feche o aplicativo no 'X' e abra novamente.");
        return;
    }
    
    tg.MainButton.setText("ENVIANDO VÍDEO...");
    tg.MainButton.show();
    tg.MainButton.showProgress();

    try {
        const res = await fetch("/api/watch-video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                cd_conteudo: conteudoId, 
                nr_id_telegram: idFresco, 
                episodioId: episodioId 
            }),
        });

        if (res.ok) {
            tg.showAlert("✅ Vídeo enviado no seu chat privado!", () => {
                tg.close();
            });
        } else {
            // 🚀 O PULO DO GATO: Lê o que o servidor falou e avisa pro cliente!
            const errData = await res.json().catch(() => ({}));
            tg.showAlert("❌ " + (errData.error || "Acesso negado pelo sistema."));
            tg.MainButton.hide();
        }
    } catch (e) {
        tg.showAlert("❌ Erro de conexão com o servidor.");
        tg.MainButton.hide();
    }
}


// --- 8. UTILITÁRIOS ---
function switchTab(tabId) {
  if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");

  const containers = document.querySelectorAll(".container");
  containers.forEach((c) => {
    c.classList.remove("active");
    c.classList.remove("fade-in");
    // 🎯 O PULO DO GATO: Isso limpa o "display: none" invisível que causava a tela preta
    c.style.display = ""; 
  });

  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach((n) => n.classList.remove("active"));

  const targetContainer = document.getElementById(tabId);
  targetContainer.classList.add("active");
  void targetContainer.offsetWidth;
  targetContainer.classList.add("fade-in");

  document.getElementById("nav-" + tabId).classList.add("active");

  if (tabId === "home") {
    document.getElementById("search-input").value = "";
    renderHome();
  }
  if (tabId === "mylist") {
      // Estoura a bolha de notificação se ela existir
      const badge = document.getElementById("badge-novo");
      if (badge) badge.remove(); 
      
      loadMyList();
  }
  if (tabId === "bestsellers") loadPlans();
}
function copyPixCode() {
  const el = document.createElement("textarea");
  el.value = currentPixCode;
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);

  if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
  tg.showAlert("✅ Chave Pix Copiada com Sucesso!");
}

function closePaymentModal() {
  clearInterval(paymentPollingInterval);
  document.getElementById("payment-modal").style.display = "none";
}

function irParaMinhaLista() {
  closePaymentModal();
  switchTab('mylist'); // Leva ele direto pra assistir
}

function openSupport() {
  if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
  tg.openTelegramLink("https://t.me/YarinTV");
}

async function fetchUserStatus() {
    if (userId === 0) return;
    try {
        const res = await fetch(`/api/user-status?userId=${userId}`);
        userStatusData = await res.json();
        
        if (userStatusData.isVip) {
            // ATIVA AS CORES DOURADAS NO CSS!
            document.body.classList.add('vip-mode');
            document.querySelector("header h1").innerHTML = 'MELREELS<i class="fas fa-crown" style="font-size: 16px;"></i>';
            
            // LÓGICA DE AVISO DE VENCIMENTO
            const exp = new Date(userStatusData.expira);
            const diffDias = Math.ceil((exp - new Date()) / (1000 * 60 * 60 * 24));
            
            if (diffDias <= 5 && diffDias > 0) {
                setTimeout(() => {
                    tg.showAlert(`⚠️ ALERTA VIP: Sua assinatura "${userStatusData.plano}" expira em ${diffDias} dias!`);
                }, 1500); // Dá 1.5s pra tela carregar antes de mostrar o alerta
            } else if (diffDias === 0) {
                setTimeout(() => {
                    tg.showAlert(`⚠️ ALERTA VIP: Sua assinatura "${userStatusData.plano}" expira HOJE!`);
                }, 1500);
            }
        }
    } catch(e) {}
}

// =================================================================
// SISTEMA DE UPSELL INTELIGENTE DO FRONTEND
// =================================================================

function fecharUpsellPosFilme() {
    const upsellOverlay = document.getElementById("upsell-pos-filme");
    if (upsellOverlay) upsellOverlay.style.display = "none";
    closePlayer();
}

function assinarViaUpsell() {
    fecharUpsellPosFilme();
    switchTab('bestsellers');
}

function mostrarBannerFlutuanteUpsell() {
    const banner = document.getElementById("floating-upsell-banner");
    if (banner) {
        banner.style.display = "flex";
    }
}

function fecharBannerFlutuanteUpsell() {
    const banner = document.getElementById("floating-upsell-banner");
    if (banner) {
        banner.style.display = "none";
    }
}

function irParaPlanosUpsell() {
    fecharBannerFlutuanteUpsell();
    switchTab('bestsellers');
}

// Iniciar app
init();