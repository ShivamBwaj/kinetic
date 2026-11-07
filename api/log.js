// POST /api/log: Kinetic Web's client logs (events and timings, never content), printed as JSON
// lines to the function log so browser-side failures are visible in Vercel. Bounded and sanitised.
const LEVELS = new Set(["info", "warn", "error"]);
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);

export async function POST(request) {
	const text = (await request.text().catch(() => "")).slice(0, 40_000);
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return new Response(null, { status: 204 });
	}
	const entries = Array.isArray(body?.entries) ? body.entries.slice(0, 50) : [];
	for (const e of entries) {
		if (!e || !LEVELS.has(e.level) || typeof e.event !== "string") continue;
		const data =
			e.data && typeof e.data === "object"
				? Object.fromEntries(Object.entries(e.data).slice(0, 20).map(([k, v]) => [clean(k, 40), typeof v === "number" || typeof v === "boolean" ? v : clean(typeof v === "object" ? JSON.stringify(v) : v, 300)]))
				: undefined;
		const line = JSON.stringify({ src: "web", level: e.level, event: clean(e.event, 60), t: Number(e.t) || Date.now(), session: clean(body.session, 12), ua: clean(body.ua, 160), data });
		if (e.level === "error") console.error(line);
		else console.log(line);
	}
	return new Response(null, { status: 204 });
}
