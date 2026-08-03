import EfiPay from "sdk-node-apis-efi";
import path from "path";
import "dotenv/config";

const options = {
  sandbox: false,
  client_id: process.env.EFI_CLIENT_ID,
  client_secret: process.env.EFI_CLIENT_SECRET,
  certificate: path.resolve("./certificado.p12"),
};

const efi = new EfiPay(options);

const efiService = {
  gerarPix: async (valor, titulo, userId, idOrigem, modalidade) => {
        const body = {
            calendario: { expiracao: 3600 },
            valor: { original: parseFloat(valor).toFixed(2) },
            chave: process.env.EFI_CHAVE_PIX,
            solicitacaoPagador: `Melreels: ${titulo}`
        };

        try {
            // ==========================================
            // PASSO 1: CRIAR A COBRANÇA
            // ==========================================
            console.log("⏳ [EFÍ] Passo 1: Solicitando criação da cobrança...");
            const cobranca = await efi.pixCreateImmediateCharge([], body);
            console.log(`✅ [EFÍ] Passo 1 Concluído! Cobrança Ativa. loc.id = ${cobranca.loc.id}`);

            // ==========================================
            // PASSO 2: GERAR A IMAGEM DO QR CODE
            // ==========================================
            console.log("⏳ [EFÍ] Passo 2: Solicitando o desenho do QR Code (Base64)...");
            const qrCode = await efi.pixGenerateQRCode({ id: cobranca.loc.id });
            
            // Verifica se a Efí realmente mandou a string da imagem
            if (!qrCode || !qrCode.imagemQrcode) {
                throw new Error("A Efí não retornou a imagem do QR Code no Passo 2.");
            }

            console.log(`✅ [EFÍ] Passo 2 Concluído! Imagem gerada com sucesso.`);

            return {
                txid: cobranca.txid,
                qrCode: qrCode.imagemQrcode, // String gigantesca com a imagem Base64
                copyPaste: qrCode.qrcode     // Texto do PIX Copia e Cola
            };
        } catch (error) {
            console.error("❌ Erro Efí Bank:", error);
            throw error;
        }
    },

  configurarWebhook: async (urlDoSeuSite) => {
    const body = { webhookUrl: `${urlDoSeuSite}/webhook-efi` };
    try {
      await efi.pixConfigWebhook({ chave: process.env.EFI_CHAVE_PIX }, body);
      console.log("✅ Webhook da Efí configurado com sucesso!");
    } catch (error) {
      console.error("❌ Erro ao configurar Webhook Efí:", error);
    }
  },
  
  consultarPix: async (txid) => {
    try {
      const params = { txid: txid };
      const cobranca = await efi.pixDetailCharge(params);
      return cobranca; // Retorna um objeto com status "ATIVA" ou "CONCLUIDA"
    } catch (error) {
      console.error(`❌ Erro ao consultar TXID ${txid} na Efí:`, error.message);
      return null;
    }
  }
};

export default efiService;
