// GET /api/admin: data for the private /admin page. Only for signed-in accounts whose Google
// email is in ADMIN_EMAILS (comma-separated, a Vercel env var); everyone else gets 404.
//   ?view=overview         totals, every account with its counts, and the latest site-wide activity
//   ?view=user&sub=<id>    one account and its full activity log
import { FOUNDING, foundingSold, redis } from "./_kv.js";
import { fail, json, linkedKey, loadUser, proEmailKey, session, TRIAL_EXPORTS, trialKey } from "./_auth.js";
import { actKey, statsKey } from "./_activity.js";

const admins = () =>
	String(process.env.ADMIN_EMAILS ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);

const parse = (s) => {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
};
const hash = (flat) => {
	// Upstash returns HGETALL as a flat [field, value, ...] array (the local store returns an object).
	if (!flat) return {};
	if (!Array.isArray(flat)) return Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, Number(v)]));
	const o = {};
	for (let i = 0; i < flat.length; i += 2) o[flat[i]] = Number(flat[i + 1]);
	return o;
};

async function userKeys() {
	const keys = [];
	let cursor = "0";
	do {
		const [next, batch] = await redis("SCAN", cursor, "MATCH", "kinetic:user:*", "COUNT", 1000);
		cursor = String(next);
		keys.push(...batch);
	} while (cursor !== "0" && keys.length < 20000);
	return keys;
}

async function summary(user) {
	const [trial, key, bought, stats] = await Promise.all([redis("GET", trialKey(user.sub)), redis("GET", linkedKey(user.sub)), user.email ? redis("GET", proEmailKey(user.email)) : null, redis("HGETALL", statsKey(user.sub))]);
	const keyOk = key ? await redis("GET", `kinetic:lic:${key}`) : null;
	return {
		sub: user.sub,
		email: user.email ?? "",
		name: user.name ?? "",
		picture: user.picture ?? "",
		createdAt: user.createdAt ?? null,
		seenAt: user.seenAt ?? null,
		onboarded: Boolean(user.onboarded),
		trialUsed: Number(trial) || 0,
		trialLimit: TRIAL_EXPORTS,
		pro: Boolean(bought) || keyOk === "1",
		proSource: bought ? "purchase" : key ? (keyOk === "0" ? "key (invalid)" : "key") : null,
		key: key ? `${key.slice(0, 4)}••••${key.slice(-4)}` : null,
		stats: hash(stats),
	};
}

export async function GET(request) {
	const s = session(request);
	if (!s || !admins().includes(String(s.email ?? "").toLowerCase())) return fail(404, "Not found.");
	const url = new URL(request.url);
	const view = url.searchParams.get("view") ?? "overview";
	try {
		if (view === "user") {
			const sub = url.searchParams.get("sub") ?? "";
			const user = await loadUser(sub);
			if (!user) return fail(404, "No such account.");
			const log = (await redis("LRANGE", actKey(sub), 0, 399)).map(parse).filter(Boolean);
			return json(200, { user: await summary(user), log });
		}
		const day = new Date().toISOString().slice(0, 10);
		const keys = await userKeys();
		const users = (await Promise.all(keys.map(async (k) => parse(await redis("GET", k))))).filter((u) => u?.sub);
		const rows = await Promise.all(users.map(summary));
		rows.sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
		const [feed, calls, spend, freeMonth, webTries, sold] = await Promise.all([
			redis("LRANGE", "kinetic:feed", 0, 299),
			redis("GET", `kinetic:calls:${day}`),
			redis("GET", `kinetic:spend:${day}`),
			redis("GET", `kinetic:freespend:${day.slice(0, 7)}`),
			redis("GET", `kinetic:web:${day}`),
			foundingSold(),
		]);
		const emails = Object.fromEntries(rows.map((r) => [r.sub, r.email]));
		const week = Date.now() - 7 * 86400e3;
		return json(200, {
			totals: {
				accounts: rows.length,
				newThisWeek: rows.filter((r) => (r.createdAt ?? 0) > week).length,
				activeThisWeek: rows.filter((r) => (r.seenAt ?? 0) > week).length,
				pro: rows.filter((r) => r.pro).length,
				trialExports: rows.reduce((n, r) => n + r.trialUsed, 0),
				aiCallsToday: Number(calls) || 0,
				aiSpendToday: Number(spend) || 0,
				freeAiSpendMonth: Number(freeMonth) || 0,
				siteTriesToday: Number(webTries) || 0,
				foundingSold: sold,
				foundingCap: FOUNDING.cap,
			},
			users: rows,
			feed: feed.map(parse).filter(Boolean).map((e) => (e.sub ? { ...e, email: emails[e.sub] ?? "" } : e)),
		});
	} catch (e) {
		console.error("admin", e);
		return fail(503, `Store error: ${e.message}`);
	}
}
