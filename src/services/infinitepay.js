import "dotenv/config";

// Checkout Integrado da InfinitePay — ao contrário da EFÍ/Mercado Pago, não
// devolve QR code/copia-e-cola direto: gera um LINK hospedado (cartão ou Pix)
// pro cliente pagar, e a confirmação chega por webhook ou polling em
// /payment_check. Autenticação é só a InfiniteTag (handle) da conta, sem
// token/segredo — não há sandbox documentado.
const HANDLE = process.env.INFINITEPAY_HANDLE;
const BASE_URL = "https://api.checkout.infinitepay.io";

async function gerarLink(valor, titulo, userId, idOrigem, modalidade) {
  if (!HANDLE) throw new Error("INFINITEPAY_HANDLE não configurado.");

  // Prefixo "IP-" pra distinguir esse NSU de txid da EFÍ (alfanumérico sem
  // traço) e do Mercado Pago (numérico) na hora de consultar o status depois.
  const orderNsu = `IP-${modalidade}-${idOrigem}-${userId}-${Date.now()}`;

  const body = {
    handle: HANDLE,
    order_nsu: orderNsu,
    items: [
      {
        quantity: 1,
        price: Math.round(parseFloat(valor) * 100), // centavos
        description: String(titulo).slice(0, 100),
      },
    ],
  };

  const publicDomain = process.env.PUBLIC_URL || "https://melreels.com.br";
  body.webhook_url = `${publicDomain}/webhook-infinitepay`;

  const res = await fetch(`${BASE_URL}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`InfinitePay respondeu ${res.status}: ${raw}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw; // alguns endpoints simples devolvem a URL como texto puro
  }

  const url = typeof data === "string" ? data : (data?.url || data?.link || data?.checkout_url);
  if (typeof url !== "string" || !/^https:\/\//.test(url)) {
    throw new Error(`InfinitePay não retornou uma URL de checkout válida: ${raw}`);
  }

  return {
    txid: orderNsu,
    link: url,
    provider: "INFINITEPAY",
  };
}

async function consultarPagamento(orderNsu) {
  try {
    const res = await fetch(`${BASE_URL}/payment_check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: HANDLE, order_nsu: orderNsu }),
    });
    if (!res.ok) return null;
    return await res.json(); // { success, paid, amount, paid_amount, installments, capture_method }
  } catch (error) {
    console.error(`❌ Erro ao consultar order_nsu ${orderNsu} na InfinitePay:`, error.message);
    return null;
  }
}

const infinitepayService = { gerarLink, consultarPagamento };
export default infinitepayService;
