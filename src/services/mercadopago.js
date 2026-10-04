import "dotenv/config";
import { MercadoPagoConfig, Payment } from "mercadopago";

function gerarCpfValido() {
  const rnd = (n) => Math.round(Math.random() * n);
  const mod = (base, div) => Math.round(base - Math.floor(base / div) * div);
  const n = Array(9).fill(0).map(() => rnd(9));
  let d1 = n.reduce((total, number, index) => total + (number * (10 - index)), 0);
  d1 = 11 - mod(d1, 11);
  if (d1 >= 10) d1 = 0;
  let d2 = d1 * 2 + n.reduce((total, number, index) => total + (number * (11 - index)), 0);
  d2 = 11 - mod(d2, 11);
  if (d2 >= 10) d2 = 0;
  return `${n.join('')}${d1}${d2}`;
}

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
        payer: {
          email: "cliente@melreels.com",
          first_name: "Cliente",
          last_name: "Melreels",
          identification: {
            type: "CPF",
            number: gerarCpfValido()
          }
        },
        additional_info: {
          items: [
            {
              id: String(idOrigem),
              title: String(titulo),
              description: `Acesso ${modalidade} - Melreels`,
              quantity: 1,
              unit_price: parseFloat(valor)
            }
          ]
        },
        metadata: {
          user_id: String(userId),
          type: modalidade,
          content_id: modalidade !== "ASSINATURA" ? String(idOrigem) : null,
          plan_id: modalidade === "ASSINATURA" ? String(idOrigem) : null,
        },
      },
    };

    const result = await payment.create(paymentData);
    const transactionData = result.point_of_interaction?.transaction_data;

    if (!transactionData) {
      console.error("❌ MercadoPago não retornou transaction_data:", JSON.stringify(result));
      return null;
    }

    return {
      txid: String(result.id),
      qrCode: transactionData.qr_code_base64, // Base64 da Imagem
      copyPaste: transactionData.qr_code,      // PIX Copia e Cola
      provider: "MERCADOPAGO"
    };
  } catch (error) {
    console.error("❌ Erro MercadoPago:", error?.cause || error?.message || error);
    throw error;
  }
}

async function consultarPix(paymentId) {
  try {
    const result = await payment.get({ id: paymentId });
    return result; // Possui .status ('approved', 'pending', etc.)
  } catch (error) {
    console.error(`❌ Erro ao consultar ID ${paymentId} no MercadoPago:`, error?.message || error);
    return null;
  }
}

const mpService = { gerarPix, consultarPix, payment };
export default mpService;