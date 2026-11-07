// POST /api/license {key}: link a Kinetic Pro licence key to the signed-in account (the same key
// as the Windows app; linking doesn't use one of its 3 PC activations). DELETE: unlink it.
import { redis } from "./_kv.js";
import { record } from "./_activity.js";
import { fail, json, linkedKey, meFor, PRO_PRODUCTS, sameOrigin, session } from "./_auth.js";

const DODO = "https://live.dodopayments.com";

export async function POST(request) {
	const s = session(request);
	if (!s) return fail(401, "Sign in first.");
	if (!sameOrigin(request)) return fail(403, "Forbidden.");
	const body = await request.json().catch(() => ({}));
	const key = String(body?.key ?? "").trim();
	if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) return json(200, { ok: false, message: "That doesn't look like a licence key. Copy it from your receipt email." });
	// Validate with Dodo directly (not the day cache), and check the product.
	let valid = false;
	let product;
	try {
		const r = await fetch(`${DODO}/licenses/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ license_key: key }), signal: AbortSignal.timeout(8000) });
		if (!r.ok) return json(200, { ok: false, message: "We couldn't check that key right now. Try again in a moment." });
		const j = await r.json();
		valid = j.valid === true;
		product = j.product_id ?? j.product?.product_id;
	} catch {
		return json(200, { ok: false, message: "Couldn't reach the licence server. Try again in a moment." });
	}
	// Dodo says {valid: false} both for a key it doesn't know and for a refunded one.
	if (!valid) return json(200, { ok: false, message: "That key isn't valid. Check it against your receipt email (refunded keys stop working)." });
	if (product && !PRO_PRODUCTS.includes(product)) return json(200, { ok: false, message: "That key is for a different product." });
	await redis("SET", `kinetic:lic:${key}`, "1", "EX", 86400);
	await redis("SET", linkedKey(s.sub), key);
	await record(s.sub, "license.link", { key: `${key.slice(0, 4)}••••${key.slice(-4)}` });
	return json(200, { ok: true, message: "Kinetic Pro is unlocked on your account. Thank you!", me: await meFor(s) });
}

export async function DELETE(request) {
	const s = session(request);
	if (!s) return fail(401, "Sign in first.");
	if (!sameOrigin(request)) return fail(403, "Forbidden.");
	await redis("DEL", linkedKey(s.sub));
	await record(s.sub, "license.unlink");
	return json(200, { ok: true, message: "The key is unlinked from this account.", me: await meFor(s) });
}
