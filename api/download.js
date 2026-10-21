// /download: tell the owner someone asked for the installer, then send them to the latest release.
import { firstInWindow, isBot, place, sendTelegram } from "./_tg.js";

const INSTALLER = "https://github.com/ShivamBwaj/kinetic/releases/latest/download/Kinetic-Setup.exe";

export default async function handler(req, res) {
	if (req.method === "GET" && !isBot(req) && firstInWindow(req, "download")) {
		let from = "direct";
		try { from = new URL(String(req.headers.referer)).host || from; } catch {}
		await sendTelegram(`⬇️ Kinetic download started\n📍 ${place(req)}\n↩️ from ${from}`);
	}
	res.setHeader("Cache-Control", "no-store");
	res.redirect(302, INSTALLER);
}
