// Upstash Redis over its REST API (one fetch per command, no SDK). Keys for Kinetic start with "kinetic:".
// KINETIC_MEMORY_STORE=1 (local development and tests only) keeps everything in this process instead.
export async function redis(...args) {
	if (process.env.KINETIC_MEMORY_STORE === "1" && process.env.VERCEL_ENV !== "production") return memory(args.map(String));
	const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
	if (!url || !token) throw new Error("store not configured");
	const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args.map(String)), signal: AbortSignal.timeout(5000) });
	if (!r.ok) throw new Error(`store ${r.status}`);
	return (await r.json()).result;
}

/** The founding offer: the first CAP buyers pay $9, then the price is $19. */
export const FOUNDING = {
	product: "pdt_0NqECMy1oc4IZHqFPZeFi",
	cap: 100,
	key: "kinetic:founding:payments",
	checkout: "https://dodo.pe/kinetic-founding",
	regularCheckout: "https://dodo.pe/kinetic-pro-launch",
};

/** Founding licences sold so far (a set of payment ids, so a retried webhook never counts twice). */
export const foundingSold = async () => Number(await redis("SCARD", FOUNDING.key)) || 0;

// ---- in-memory stand-in for local development (the subset of Redis the site uses) ----
const mem = new Map();
const expiry = new Map();
function live(key) {
	const at = expiry.get(key);
	if (at && at <= Date.now()) {
		mem.delete(key);
		expiry.delete(key);
	}
	return mem.get(key);
}
function memory([cmd, key, ...rest]) {
	const c = cmd.toUpperCase();
	const num = () => Number(live(key) ?? 0) || 0;
	switch (c) {
		case "GET": return live(key) ?? null;
		case "GETDEL": { const v = live(key) ?? null; mem.delete(key); return v; }
		case "DEL": return mem.delete(key) ? 1 : 0;
		case "SET": {
			const nx = rest.includes("NX"), ex = rest.indexOf("EX");
			if (nx && live(key) !== undefined) return null;
			mem.set(key, rest[0]);
			if (ex >= 0) expiry.set(key, Date.now() + Number(rest[ex + 1]) * 1000); else expiry.delete(key);
			return "OK";
		}
		case "INCR": mem.set(key, String(num() + 1)); return num();
		case "DECR": mem.set(key, String(num() - 1)); return num();
		case "INCRBY": mem.set(key, String(num() + Number(rest[0]))); return num();
		case "INCRBYFLOAT": mem.set(key, String(num() + Number(rest[0]))); return String(num());
		case "EXPIRE": if (live(key) === undefined) return 0; expiry.set(key, Date.now() + Number(rest[0]) * 1000); return 1;
		case "SADD": { const s = live(key) ?? new Set(); const n = rest.filter((m) => !s.has(m)).length; rest.forEach((m) => s.add(m)); mem.set(key, s); return n; }
		case "SREM": { const s = live(key); if (!s) return 0; const n = rest.filter((m) => s.delete(m)).length; return n; }
		case "SCARD": return live(key)?.size ?? 0;
		case "SISMEMBER": return live(key)?.has(rest[0]) ? 1 : 0;
		case "HINCRBY": { const h = live(key) ?? new Map(); h.set(rest[0], (Number(h.get(rest[0]) ?? 0) || 0) + Number(rest[1])); mem.set(key, h); return h.get(rest[0]); }
		case "HGETALL": { const h = live(key); return h ? Object.fromEntries(h) : {}; }
		case "LPUSH": { const l = live(key) ?? []; l.unshift(...rest); mem.set(key, l); return l.length; }
		case "LTRIM": { const l = live(key); if (l) mem.set(key, l.slice(Number(rest[0]), Number(rest[1]) + 1)); return "OK"; }
		case "LRANGE": { const l = live(key) ?? []; return l.slice(Number(rest[0]), Number(rest[1]) + 1); }
		case "SCAN": {
			// One pass over every key (cursor always ends at 0), filtered by the MATCH glob.
			const m = rest[rest.indexOf("MATCH") + 1] ?? "*";
			const re = new RegExp(`^${m.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
			return ["0", [...mem.keys()].filter((k) => live(k) !== undefined && re.test(k))];
		}
		default: throw new Error(`memory store: ${c} is not supported`);
	}
}
