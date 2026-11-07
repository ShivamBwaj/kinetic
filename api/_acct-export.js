// POST /api/export: the free trial's export counter. The video itself renders in the browser and
// is never uploaded; this only decides whether an export may start and records that it did.
//   {action: "start", aspects}  -> {ok, token, left}  (Pro: always; free: up to TRIAL_EXPORTS, else 402)
//   {action: "finish", token, stats}                    (timings, printed to the function log)
//   {action: "refund", token}   a failed or cancelled export gives its trial export back, once
import { randomUUID } from "node:crypto";
import { redis } from "./_kv.js";
import { fail, json, loadUser, planOf, sameOrigin, session, TRIAL_EXPORTS, trialKey } from "./_auth.js";
import { firstInWindow, place, sendTelegram } from "./_tg.js";

const TOKEN_TTL = 6 * 3600;
const ASPECTS = new Set(["16:9", "9:16", "1:1", "4:5"]);

export async function POST(request) {
	const s = session(request);
	if (!s) return fail(401, "Sign in to export.");
	if (!sameOrigin(request)) return fail(403, "Forbidden.");
	const body = await request.json().catch(() => ({}));
	const action = body?.action;
	const user = await loadUser(s.sub);
	if (!user) return fail(401, "Sign in again.");
	const req = { headers: Object.fromEntries(request.headers) };

	if (action === "start") {
		const aspects = (Array.isArray(body.aspects) ? body.aspects : []).filter((a) => ASPECTS.has(a)).slice(0, 4);
		const { pro } = await planOf(user);
		let left = null;
		if (!pro) {
			// INCR first, then check: two tabs exporting at once can't both take the last one.
			const used = Number(await redis("INCR", trialKey(user.sub)));
			if (used > TRIAL_EXPORTS) {
				await redis("DECR", trialKey(user.sub));
				return fail(402, `You've used your ${TRIAL_EXPORTS} free exports. Get Kinetic Pro for unlimited exports.`, "trial_used");
			}
			left = TRIAL_EXPORTS - used;
		}
		const token = randomUUID();
		await redis("SET", `kinetic:exp:${token}`, JSON.stringify({ sub: user.sub, pro, at: Date.now(), aspects }), "EX", TOKEN_TTL);
		return json(200, { ok: true, token, left });
	}

	const token = typeof body?.token === "string" && /^[0-9a-f-]{36}$/.test(body.token) ? body.token : null;
	if (!token) return fail(400, "Bad request.");
	const raw = await redis("GET", `kinetic:exp:${token}`);
	const rec = raw ? JSON.parse(raw) : null;
	if (!rec || rec.sub !== user.sub) return fail(404, "Unknown export.");

	if (action === "refund") {
		// GETDEL makes the refund one-shot even if the browser retries.
		if ((await redis("GETDEL", `kinetic:exp:${token}`)) && !rec.pro) await redis("DECR", trialKey(user.sub));
		return json(200, { ok: true });
	}
	if (action === "finish") {
		await redis("DEL", `kinetic:exp:${token}`);
		const st = body.stats && typeof body.stats === "object" ? body.stats : {};
		const runs = Array.isArray(st.runs) ? st.runs.slice(0, 4) : [];
		const summary = runs.map((r) => `${ASPECTS.has(r?.aspect) ? r.aspect : "?"} ${Number(r?.frames) || 0}f @ ${Number(r?.msPerFrame) || 0}ms`).join(", ");
		console.log(JSON.stringify({ event: "web.export", pro: rec.pro, ms: Number(st.ms) || 0, draft: st.draft === true, runs: summary }));
		if (firstInWindow(req, "web-export")) await sendTelegram(`🎬 Web export (${rec.pro ? "Pro" : "trial"}): ${summary || "done"} in ${Math.round((Number(st.ms) || 0) / 1000)}s\n📍 ${place(req)}`);
		return json(200, { ok: true });
	}
	return fail(400, "Bad request.");
}
