// /api/write: Kinetic's hosted AI writer. OpenAI-compatible (POST {messages}), so the app's
// "hosted" path calls it like any provider. The OpenRouter key stays here; the model is fixed.
//
// Who pays: Authorization: Bearer <installId> (a random UUID the app creates), plus an optional
// X-Kinetic-License header for Pro. Free installs get 3 film writes and 10 scene rewrites; Pro
// gets 100 writes a month. X-Kinetic-Kind says what the call is: "write", "repair" (the app's
// one automatic retry after a write, free within 5 minutes) or "scene". A failed model call
// gives the credit back. A daily per-network cap stops reinstall farming.
import { cookieValue, loadUser, planOf, readSessionToken } from "./_auth.js";
import { redis } from "./_kv.js";
import { promptOf, record } from "./_activity.js";
import { firstInWindow, place, sendTelegram } from "./_tg.js";

const MODELS = ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-flash"];
const FREE = { write: 3, scene: 10 };
const PRO_WRITES_PER_MONTH = 100;
const NET_PER_DAY = 30;
// Free writes for the whole site per day: at most about $12 of AI a day even at the price cap.
const GLOBAL_FREE_PER_DAY = 2500;
// The website's try-it box: fewer films per visitor and per day, and a shorter, cheaper film.
const WEB_FREE = 2;
const WEB_PER_DAY = 150;
const WEB_MAX_TOKENS = 3000;
// Hard budget for all free AI (website + free app users) per calendar month, in USD. When it's
// spent, free writes pause (the app falls back to its built-in writer); Pro keeps working.
const FREE_BUDGET_USD = 2;
const MAX_CHARS = 90_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
	const web = req.headers["x-kinetic-src"] === "web";
	// A signed-in Kinetic Web account (session cookie): its prompts go on its /admin activity log.
	// The desktop app has no session, so its prompts are never recorded.
	const sessionSub = readSessionToken(cookieValue({ headers: { get: () => String(req.headers.cookie || "") } }))?.sub ?? null;
	const prompt = promptOf(messages);
	// Website refusals are reported, so a visitor who sees an error never goes unnoticed.
	// At most one alert per visitor network every 10 minutes, so retries can't flood the chat.
	const deny = async (res, status, message, extra) => {
		if (web || sessionSub) await record(web ? null : sessionSub, "write.denied", { status, why: message, prompt, ...(web ? { src: "homepage", visitor: install.slice(0, 8), place: place(req) } : {}) });
		if (web && firstInWindow(req, `deny${status}`)) await sendTelegram(`❌ Website film refused (${status}): ${message}\n📍 ${place(req)}`).catch(() => {});
		return fail(res, status, message, extra);
	};

	let charged = null, left = null, pro = false;
	try {
		const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
		const day = new Date().toISOString().slice(0, 10);
		pro = await isPro(String(req.headers["x-kinetic-license"] || ""));
		// Kinetic Web: a signed-in Pro account (bought with this email, or a linked key) is Pro too.
		if (!pro) {
			const s = readSessionToken(cookieValue({ headers: { get: () => String(req.headers.cookie || "") } }));
			if (s) {
				const user = await loadUser(s.sub);
				pro = Boolean(user && user.installId === install && (await planOf(user)).pro);
			}
		}
		if (kind === "repair") {
			// One free retry right after a charged write.
			if ((await redis("GETDEL", `kinetic:rep:${install}`)) !== "ready") return deny(res, 402, "No retry available.", { code: "no_credits" });
		} else {
			if (!pro) {
				const spentMonth = Number(await redis("GET", `kinetic:freespend:${day.slice(0, 7)}`)) || 0;
				if (spentMonth >= FREE_BUDGET_USD) return deny(res, 429, web ? "The free AI films on the website are paused for now. Download Kinetic: its built-in writer is free and works offline." : "Kinetic AI's free writes are paused for now. The built-in writer still works, or add your own API key in AI settings.", { code: "budget" });
				if (web) {
					const w = Number(await redis("INCR", `kinetic:web:${day}`));
					if (w === 1) await redis("EXPIRE", `kinetic:web:${day}`, 90000);
					if (w > WEB_PER_DAY) {
						if (w === WEB_PER_DAY + 1) await sendTelegram(`⚠️ The website's try-it box hit today's cap (${WEB_PER_DAY} films).`);
						return deny(res, 429, "Lots of people are trying Kinetic today. Download it free: the built-in writer works offline.", { code: "rate" });
					}
				}
				const net = Number(await redis("INCR", `kinetic:net:${ip}:${day}`));
				if (net === 1) await redis("EXPIRE", `kinetic:net:${ip}:${day}`, 90000);
				if (net > NET_PER_DAY) return deny(res, 429, "Too many AI writes from this network today. Try again tomorrow.", { code: "rate" });
				// A ceiling for the whole site, so a traffic spike or a bot farm can't run up the AI bill.
				const all = Number(await redis("INCR", `kinetic:all:${day}`));
				if (all === 1) await redis("EXPIRE", `kinetic:all:${day}`, 90000);
				if (all > GLOBAL_FREE_PER_DAY) {
					if (all === GLOBAL_FREE_PER_DAY + 1) await sendTelegram(`⚠️ Free AI writes hit today's site-wide cap (${GLOBAL_FREE_PER_DAY}). Pro users still work.`);
					return deny(res, 429, "Kinetic AI is very busy today. Download Kinetic and use the built-in writer, or try again tomorrow.", { code: "rate" });
				}
			}
			const month = day.slice(0, 7);
			const key = pro ? `kinetic:pro:${install}:${month}` : `kinetic:free:${kind}:${install}`;
			const limit = pro ? (kind === "write" ? PRO_WRITES_PER_MONTH : PRO_WRITES_PER_MONTH * 3) : web ? WEB_FREE : FREE[kind];
			const used = Number(await redis("INCR", key));
			if (pro && used === 1) await redis("EXPIRE", key, 40 * 86400);
			if (used > limit) {
				await redis("DECR", key);
				return deny(res, 402, pro ? "This month's AI writes are used up." : `Your ${web ? WEB_FREE : FREE[kind]} free AI ${kind === "write" ? "writes" : "scene rewrites"} are used up. Kinetic Pro includes ${PRO_WRITES_PER_MONTH} a month, or add your own API key in AI settings.`, { code: "no_credits" });
			}
			charged = key;
			left = limit - used;
			if (kind === "write") await redis("SET", `kinetic:rep:${install}`, "ready", "EX", 300);
		}
	} catch (e) {
		console.error("credits", e);
		return deny(res, 503, "The Kinetic writer is busy. Try again in a minute.");
	}

	try {
		// Fastest provider wins (films are 3-5k tokens, so speed per token is what users wait on), but never one priced
		// above $0.30 in / $1.20 out per million tokens: a write stays under about 0.6 cents.
		const ask = (maxTokens, ms) =>
			fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json", "HTTP-Referer": "https://kinetic.launchloop.tech", "X-Title": "Kinetic" },
				body: JSON.stringify({ models: MODELS, messages, temperature: 1, max_tokens: maxTokens, response_format: { type: "json_object" }, provider: { sort: "throughput", max_price: { prompt: 0.3, completion: 1.2 } }, usage: { include: true } }),
				signal: AbortSignal.timeout(ms),
			}).then(async (r) => ({ r, data: await r.json().catch(() => null) }));
		let { r, data } = await ask(web ? WEB_MAX_TOKENS : 6000, 30_000);
		let content = data?.choices?.[0]?.message?.content;
		if (r.ok && !content) {
			// The model sometimes returns an empty answer (it ran out of room); one retry with more room.
			console.error("model empty", data?.choices?.[0]?.finish_reason, data?.provider);
			({ r, data } = await ask(6000, 25_000));
			content = data?.choices?.[0]?.message?.content;
		}
		if (!r.ok || !content) throw new Error(data?.error?.message || `model ${r.status} ${data?.choices?.[0]?.finish_reason ?? ""}`);
		if (left != null) res.setHeader("X-Kinetic-Left", String(left));
		res.setHeader("X-Kinetic-Plan", pro ? "pro" : "free");
		const usd = typeof data.usage?.cost === "number" ? data.usage.cost : null;
		const cost = usd == null ? "cost n/a" : `$${usd.toFixed(4)}`;
		// Running totals for today, so every alert shows what the AI has cost so far.
		const today = new Date().toISOString().slice(0, 10);
		let totals = "";
		try {
			const n = Number(await redis("INCR", `kinetic:calls:${today}`));
			const spent = usd == null ? Number(await redis("GET", `kinetic:spend:${today}`)) || 0 : Number(await redis("INCRBYFLOAT", `kinetic:spend:${today}`, String(usd)));
			if (n === 1) await Promise.all([redis("EXPIRE", `kinetic:calls:${today}`, 8 * 86400), redis("EXPIRE", `kinetic:spend:${today}`, 8 * 86400)]);
			if (!pro && usd != null) {
				const month = today.slice(0, 7);
				const free = Number(await redis("INCRBYFLOAT", `kinetic:freespend:${month}`, String(usd)));
				totals += `\n💰 Free AI this month: $${free.toFixed(3)} of $${FREE_BUDGET_USD} budget`;
				if (free >= FREE_BUDGET_USD && free - usd < FREE_BUDGET_USD) await sendTelegram(`🛑 Free AI budget ($${FREE_BUDGET_USD}) used up for ${month}. Free writes are paused; Pro still works. Raise FREE_BUDGET_USD in api/write.js to resume.`);
			}
			totals = `\n📊 Today: ${n} AI calls, $${spent.toFixed(3)} spent`;
		} catch {}
		if (web) await record(null, "try", { prompt, visitor: install.slice(0, 8), place: place(req), cost: usd ?? undefined, model: data.model, left: left ?? undefined });
		else if (sessionSub) await record(sessionSub, kind, { prompt, plan: pro ? "pro" : "free", left: left ?? undefined, cost: usd ?? undefined, model: data.model });
		if (kind === "write") {
			// What the visitor typed (from the brief), so you can see what people try on the site.
			// Only website prompts are logged (the privacy page says so); app users' descriptions never are.
			const brief = web ? (messages.find((m) => m.role === "user")?.content.match(/BRIEF: (.*)/)?.[1] ?? "").slice(0, 160) : "";
			await sendTelegram(`✍️ AI film written ${web ? "🌐 on the website" : "in the app"} (${pro ? "Pro" : `free, ${left} left`})${brief ? `\n💬 "${brief}"` : ""}\n🤖 ${data.model} via ${data.provider ?? "?"} · ${cost}${totals}\n📍 ${place(req)}`);
		}
		return res.status(200).json({ choices: [{ message: { role: "assistant", content } }], model: data.model, provider: data.provider, cost: data.usage?.cost });
	} catch (e) {
		console.error("model", e);
		if (charged) await redis("DECR", charged).catch(() => {});
		return deny(res, 502, "The AI didn't answer. Your credit was not used.");
	}
}

export const config = { maxDuration: 60 };
