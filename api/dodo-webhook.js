// Dodo Payments webhook: counts founding sales for the price ladder and tells the owner about
// every Kinetic sale on Telegram. Standard Webhooks signature (HMAC-SHA256 over id.timestamp.body).
import { createHmac, timingSafeEqual } from "node:crypto";
import { FOUNDING, foundingSold, redis } from "./_kv.js";
import { sendTelegram } from "./_tg.js";

const NAMES = {
	[FOUNDING.product]: "Kinetic Pro (Founding)",
	pdt_0NqA9CUb0BH6yLPmkMtSi: "Kinetic Pro",
	pdt_0NqA9CVwsSA5Jih9YKAQD: "Kinetic Pro ($29)",
	pdt_0NqBw1PaNYaZBI4i4Xs6A: "Maker Kit (Kinetic + Pipto)",
	pdt_0NqBw1MJAzXT1jASBfJc9: "Launch video service ($49)",
	pdt_0NqBw1NTfOMhJVpRRCg2q: "Launch video pack ($99)",
	pdt_0NpsOesQn6NDbtFslr82U: "Pipto Pro",
	pdt_0NpsOeti7qSjP2xN9mRqF: "Pipto Pro (early)",
};

function verify(secret, id, timestamp, signature, body) {
	if (!secret || !id || !timestamp || !signature) return false;
	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
	const expected = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest();
	return signature.split(" ").some((part) => {
		const [v, value] = part.split(",", 2);
		if (v !== "v1" || !value) return false;
		const given = Buffer.from(value, "base64");
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}

export async function POST(request) {
	const body = await request.text();
	const h = (k) => request.headers.get(k);
	if (!verify(process.env.DODO_WEBHOOK_SECRET, h("webhook-id"), h("webhook-timestamp"), h("webhook-signature"), body)) return new Response("bad signature", { status: 401 });
	let event;
	try {
		event = JSON.parse(body);
	} catch {
		return new Response("bad json", { status: 400 });
	}
	const d = event?.data ?? {};
	const cart = Array.isArray(d.product_cart) ? d.product_cart : [];
	const pay = String(d.payment_id ?? "");
	try {
		if (event.type === "payment.succeeded" && pay) {
			const founding = cart.some((i) => i?.product_id === FOUNDING.product);
			if (founding) await redis("SADD", FOUNDING.key, pay);
			// Telegram once per payment, whatever Dodo retries.
			if ((await redis("SET", `kinetic:paid:${pay}`, "1", "NX", "EX", 30 * 86400)) === "OK") {
				const items = cart.map((i) => NAMES[i?.product_id] ?? i?.product_id).join(", ") || "a product";
				const amount = typeof d.total_amount === "number" ? `${(d.total_amount / 100).toFixed(2)} ${d.currency ?? ""}`.trim() : "";
				const ladder = founding ? `\n🪜 Founding: ${await foundingSold()} of ${FOUNDING.cap} sold` : "";
				await sendTelegram(`💰 SALE: ${items}${amount ? ` for ${amount}` : ""}${d.customer?.country ? ` (${d.customer.country})` : ""}${ladder}`);
			}
		} else if (event.type === "refund.succeeded" && pay) {
			await redis("SREM", FOUNDING.key, pay);
			await sendTelegram(`↩️ Refund on payment ${pay}`);
		}
	} catch (e) {
		console.error(e);
		return new Response("store error", { status: 500 });
	}
	return new Response("ok");
}
