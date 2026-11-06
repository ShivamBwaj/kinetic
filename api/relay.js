// /api/relay: lets the owner's other sites (Pipto) post to the same Telegram chat without holding the bot token.
// Locked with a shared RELAY_KEY; plain text only, capped in length.
import { timingSafeEqual } from "node:crypto";
import { sendTelegram } from "./_tg.js";

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default async function handler(req, res) {
	res.setHeader("Cache-Control", "no-store");
	if (req.method !== "POST") return res.status(405).end();
	const key = process.env.RELAY_KEY || "";
	const given = String(req.headers["x-relay-key"] || "");
	if (!key || !same(key, given)) return res.status(401).end();
	let b = req.body;
	if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
	const text = typeof b?.text === "string" ? b.text.slice(0, 600) : "";
	if (!text) return res.status(400).end();
	res.status((await sendTelegram(text)) ? 204 : 502).end();
}
