import "dotenv/config";
import { MercadoPagoConfig, Payment } from "mercadopago";

// Configuração com seu Access Token (obtido no painel do MP)
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});
const payment = new Payment(client);

async function gerarPix(valor, titulo, userId, idOrigem, modalidade) {
  try {
    const paymentData = {
      body: {
        transaction_amount: parseFloat(valor),
        description: `Melreels - ${titulo}`, // Descrição curta do PIX
        payment_method_id: "pix",
        payer: { email: "cliente@melreels.com" },
        additional_info: {
          items: [
            {
              id: idOrigem,
              title: titulo,
              description: `Acesso ${modalidade} - Melreels`,
              quantity: 1,
              unit_price: parseFloat(valor)
            }
          ]
        },

        // ESSA PARTE É O CORAÇÃO DO WEBHOOK
        metadata: {
          user_id: userId,
          type: modalidade,
          content_id: modalidade !== "ASSINATURA" ? idOrigem : null,
          plan_id: modalidade === "ASSINATURA" ? idOrigem : null,
        },
      },
    };

    const result = await payment.create(paymentData);
    return {
      id: result.id,
      qrCode: result.point_of_interaction.transaction_data.qr_code,
      copyPaste: result.point_of_interaction.transaction_data.qr_code_base64,
    };
  } catch (error) {
    console.error("Erro MP:", error);
    return null;
  }
}

const mpService = { gerarPix, payment };
export default mpService;