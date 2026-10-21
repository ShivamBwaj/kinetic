// /api/write: Kinetic's hosted AI writer. OpenAI-compatible (POST {messages}), so the app's
// "hosted" path calls it like any provider. The OpenRouter key stays here; the model is fixed.
//
// Who pays: Authorization: Bearer <installId> (a random UUID the app creates), plus an optional
// X-Kinetic-License header for Pro. Free installs get 3 film writes and 10 scene rewrites; Pro
// gets 100 writes a month. X-Kinetic-Kind says what the call is: "write", "repair" (the app's
// one automatic retry after a write, free within 5 minutes) or "scene". A failed model call
// gives the credit back. A daily per-network cap stops reinstall farming.
import { place, sendTelegram } from "./_tg.js";

const MODELS = ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-flash"];
const FREE = { write: 3, scene: 10 };
const PRO_WRITES_PER_MONTH = 100;
const NET_PER_DAY = 30;
const MAX_CHARS = 90_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function redis(...args) {
	const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
	if (!url || !token) throw new Error("store not configured");
	const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args.map(String)), signal: AbortSignal.timeout(5000) });
	if (!r.ok) throw new Error(`store ${r.status}`);
	return (await r.json()).result;
}

/** Pro if Dodo says the key is valid; cached for a day either way so Dodo isn't hit per call. */
async function isPro(key) {
	if (!key || !/^[A-Za-z0-9-]{8,128}$/.test(key)) return false;
	const cacheKey = `kinetic:lic:${key}`;
	const cached = await redis("GET", cacheKey);
	if (cached === "1" || cached === "0") return cached === "1";
	let ok = false;
	try {
		const r = await fetch("https://live.dodopayments.com/licenses/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ license_key: key }), signal: AbortSignal.timeout(6000) });
		ok = r.ok && (await r.json()).valid === true;
	} catch {
		return false;
	}
	await redis("SET", cacheKey, ok ? "1" : "0", "EX", 86400);
	return ok;
}

const fail = (res, status, message, extra = {}) => res.status(status).json({ error: { message, ...extra } });

export default async function handler(req, res) {
	res.setHeader("Cache-Control", "no-store");
	if (req.method !== "POST") return fail(res, 405, "POST only.");
	const install = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
	if (!UUID.test(install)) return fail(res, 401, "Unknown install.");
	let body = req.body;
	if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
	const messages = Array.isArray(body?.messages) ? body.messages.filter((m) => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string") : [];
	if (!messages.length || messages.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) return fail(res, 400, "Bad request.");
	const kind = ["write", "repair", "scene"].includes(req.headers["x-kinetic-kind"]) ? req.headers["x-kinetic-kind"] : "write";

	let charged = null, left = null, pro = false;
	try {
		const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
		const day = new Date().toISOString().slice(0, 10);
		pro = await isPro(String(req.headers["x-kinetic-license"] || ""));
		if (kind === "repair") {
			// One free retry right after a charged write.
			if ((await redis("GETDEL", `kinetic:rep:${install}`)) !== "ready") return fail(res, 402, "No retry available.", { code: "no_credits" });
		} else {
			if (!pro) {
				const net = Number(await redis("INCR", `kinetic:net:${ip}:${day}`));
				if (net === 1) await redis("EXPIRE", `kinetic:net:${ip}:${day}`, 90000);
				if (net > NET_PER_DAY) return fail(res, 429, "Too many AI writes from this network today. Try again tomorrow.", { code: "rate" });
			}
			const month = day.slice(0, 7);
			const key = pro ? `kinetic:pro:${install}:${month}` : `kinetic:free:${kind}:${install}`;
			const limit = pro ? (kind === "write" ? PRO_WRITES_PER_MONTH : PRO_WRITES_PER_MONTH * 3) : FREE[kind];
			const used = Number(await redis("INCR", key));
			if (pro && used === 1) await redis("EXPIRE", key, 40 * 86400);
			if (used > limit) {
				await redis("DECR", key);
				return fail(res, 402, pro ? "This month's AI writes are used up." : `Your ${FREE[kind]} free AI ${kind === "write" ? "writes" : "scene rewrites"} are used up. Kinetic Pro includes ${PRO_WRITES_PER_MONTH} a month, or add your own API key in AI settings.`, { code: "no_credits" });
			}
			charged = key;
			left = limit - used;
			if (kind === "write") await redis("SET", `kinetic:rep:${install}`, "ready", "EX", 300);
		}
	} catch (e) {
		console.error("credits", e);
		return fail(res, 503, "The Kinetic writer is busy. Try again in a minute.");
	}

	try {
		const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json", "HTTP-Referer": "https://kinetic.launchloop.tech", "X-Title": "Kinetic" },
			body: JSON.stringify({ models: MODELS, messages, temperature: 0.8, max_tokens: 6000, response_format: { type: "json_object" } }),
			signal: AbortSignal.timeout(55_000),
		});
		const data = await r.json().catch(() => null);
		const content = data?.choices?.[0]?.message?.content;
		if (!r.ok || !content) throw new Error(data?.error?.message || `model ${r.status}`);
		if (left != null) res.setHeader("X-Kinetic-Left", String(left));
		res.setHeader("X-Kinetic-Plan", pro ? "pro" : "free");
		if (kind === "write") await sendTelegram(`✍️ AI film written (${pro ? "Pro" : `free, ${left} left`})\n📍 ${place(req)}`);
		return res.status(200).json({ choices: [{ message: { role: "assistant", content } }], model: data.model });
	} catch (e) {
		console.error("model", e);
		if (charged) await redis("DECR", charged).catch(() => {});
		return fail(res, 502, "The AI didn't answer. Your credit was not used.");
	}
}

export const config = { maxDuration: 60 };
