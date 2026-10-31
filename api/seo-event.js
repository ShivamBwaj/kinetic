// Private aggregate SEO funnel counters. No public reporting endpoint or user IDs.
import { redis } from "./_kv.js";
import { firstInWindow, isBot } from "./_tg.js";
import { SEO_ROUTES } from "./_seo-routes.js";

export default async function handler(req, res) {
	res.setHeader("Cache-Control", "no-store");
	if (req.method !== "POST") return res.status(405).end();
	const origin = req.headers.origin;
	if (origin && origin !== "https://kinetic.launchloop.tech") return res.status(403).end();
	if (isBot(req)) return res.status(204).end();
	let b = req.body;
	if (typeof b === "string") {
		if (b.length > 1000) return res.status(400).end();
		try { b = JSON.parse(b); } catch { return res.status(400).end(); }
	}
	if (!b || typeof b !== "object" || !SEO_ROUTES.has(b.source) || !SEO_ROUTES.has(b.landing)) return res.status(400).end();
	const valid = b.event === "internal" ? SEO_ROUTES.has(b.destination) && b.source !== b.destination
		: b.event === "download" ? b.destination === "/download"
		: b.event === "checkout" && b.destination === "/buy";
	if (!valid) return res.status(400).end();
	const field = `${b.event}|${b.landing}|${b.source}|${b.destination}`;
	// Repeated identical events from a network are counted once per 10-minute warm-instance window.
	if (!firstInWindow(req, `seo:${field}`)) return res.status(204).end();
	try {
		const key = `kinetic:seo:${new Date().toISOString().slice(0, 10)}`;
		await redis("HINCRBY", key, field, 1);
		await redis("EXPIRE", key, 120 * 86400);
	} catch (e) { console.error("seo counter unavailable"); }
	return res.status(204).end();
}
