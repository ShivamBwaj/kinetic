// /api/track: small, fixed set of events from the site and the Kinetic app, relayed to the owner's Telegram.
// Only whitelisted events and values are accepted; anything else is ignored.
import { firstInWindow, isBot, place, sendTelegram } from "./_tg.js";

const ASPECTS = new Set(["16:9", "9:16", "1:1", "4:5"]);
const clean = (v, re) => (typeof v === "string" && re.test(v) ? v : "");

const MESSAGES = {
	buy: (b) => `💳 Buy button clicked (${b.from === "app" ? "in the app" : "on the site"})`,
	install: (b) => `🟢 Kinetic opened for the first time${b.v ? ` (v${b.v})` : ""}`,
	export: (b) => `🎬 Video exported${b.aspect ? ` ${b.aspect}` : ""}${b.gif ? " + GIF" : ""}, ${b.pro ? "Pro" : b.badge ? "free, with badge" : "free, clean"}`,
	activate: () => `🔑 Kinetic Pro activated`,
};

export default async function handler(req, res) {
	res.setHeader("Cache-Control", "no-store");
	if (req.method !== "POST") return res.status(405).end();
	let b = req.body;
	if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
	b = b && typeof b === "object" ? b : {};
	const e = clean(b.e, /^(buy|install|export|activate)$/);
	if (!e || isBot(req)) return res.status(204).end();
	const body = {
		from: clean(b.from, /^(site|app)$/),
		v: clean(b.v, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
		aspect: ASPECTS.has(b.aspect) ? b.aspect : "",
		gif: b.gif === true,
		pro: b.pro === true,
		badge: b.badge === true,
	};
	if (firstInWindow(req, e + body.aspect)) await sendTelegram(`${MESSAGES[e](body)}\n📍 ${place(req)}`);
	res.status(204).end();
}
