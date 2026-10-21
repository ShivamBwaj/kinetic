// Owner alerts on Telegram. Best effort: a failed or unconfigured send never blocks the caller.
// Nothing personal is sent: event name, app version, and the approximate country/city Vercel derives
// from the request. IP addresses are used only in memory, to drop repeats, and never stored or sent.

const seen = new Map();
const REPEAT_MS = 10 * 60_000;

/** True the first time this network sends this event within 10 minutes (per warm instance). */
export function firstInWindow(req, event) {
	const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
	const key = `${ip}|${event}`, now = Date.now(), last = seen.get(key);
	if (last && now - last < REPEAT_MS) return false;
	seen.set(key, now);
	if (seen.size > 5000) seen.clear();
	return true;
}

export function place(req) {
	const h = (k) => { try { return decodeURIComponent(String(req.headers[k] || "")); } catch { return ""; } };
	return [h("x-vercel-ip-city"), h("x-vercel-ip-country")].filter(Boolean).join(", ") || "unknown place";
}

export const isBot = (req) => /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|headless/i.test(String(req.headers["user-agent"] || ""));

export async function sendTelegram(text) {
	const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
	if (!token || !chat) return false;
	try {
		const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: chat, text, link_preview_options: { is_disabled: true } }),
			signal: AbortSignal.timeout(2500),
		});
		return r.ok;
	} catch {
		return false;
	}
}
