import fs from 'fs';
import pool from './src/services/db.js';

// 1. Configurações - Ajuste os caminhos se necessário
const LOG_OUT = 'C:\\Users\\Acer nitro 5\\.pm2\\logs\\melreels-server-out.log';
const LOG_ERR = 'C:\\Users\\Acer nitro 5\\.pm2\\logs\\melreels-server-error.log';

const NOVO_PLANO_ID = 'COLOQUE_O_ID_DO_NOVO_PLANO_AQUI';

async function recuperarAcessos() {
    console.log("🔍 Iniciando varredura nos logs do PM2...");
    
    let outLog = '';
    let errLog = '';
    
    try { outLog = fs.readFileSync(LOG_OUT, 'utf8'); } catch(e) { console.log("Aviso: out.log não lido"); }
    try { errLog = fs.readFileSync(LOG_ERR, 'utf8'); } catch(e) { console.log("Aviso: error.log não lido"); }
    
    const conteudoTotal = outLog + '\n' + errLog;
    
    // Regex para capturar IDs (Acesso Autorizado para ID xxxx ou user xxxx)
    const regex = /(?:ID |user )(\d{6,15})/g;
    let match;
    const idsEncontrados = new Set();
    
    while ((match = regex.exec(conteudoTotal)) !== null) {
        idsEncontrados.add(match[1]);
    }
    
    const arrayIds = Array.from(idsEncontrados);
    console.log(`✅ ${arrayIds.length} IDs únicos encontrados nos logs.`);
    
    if (arrayIds.length === 0) {
        console.log("Nenhum ID extraído. Abortando.");
        return;
    }

    // ====================================================================
    // ATENÇÃO: Descomente o bloco abaixo APENAS se quiser inserir o plano 
    // para TODOS os usuários extraídos do log.
    // ====================================================================
    
    /*
    console.log("⏳ Restaurando acessos no banco de dados...");
    const expira = new Date();
    expira.setDate(expira.getDate() + 30); // Configura 30 dias de acesso

    // Insere as novas vendas
    try {
        for (const id of arrayIds) {
            await pool.query(
                `INSERT INTO "VENDAS" (nr_id_telegram, cd_plano, tp_compra, tp_status, ts_expiracao) VALUES ($1, $2, $3, $4, $5)`,
                [parseInt(id), NOVO_PLANO_ID, "ASSINATURA", "APROVADA", expira.toISOString()]
            );
        }
        console.log("🎉 Acessos restaurados com sucesso para todos os IDs extraídos!");
    } catch (error) {
        console.error("❌ Erro ao restaurar no banco:", error.message);
    }
    */
}

recuperarAcessos();