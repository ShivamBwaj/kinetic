// /buy: Kinetic Pro checkout. The founding $9 checkout while spots remain, the $19 one after.
// The site, the app and every post link here, so the price switches everywhere at once.
import { FOUNDING, foundingSold } from "./_kv.js";
import { firstInWindow, isBot, place, sendTelegram } from "./_tg.js";

export async function GET(request) {
	let sold = 0;
	try {
		sold = await foundingSold();
	} catch (e) {
		console.error(e);
	}
	const open = sold < FOUNDING.cap;
	const req = { headers: Object.fromEntries(request.headers) };
	if (!isBot(req) && firstInWindow(req, "buy-redirect")) {
		const from = new URL(request.url).searchParams.get("from") === "app" ? "in the app" : "on the site";
		await sendTelegram(`💳 Checkout opened ${from} (${open ? `$9 founding, ${sold}/${FOUNDING.cap} sold` : "$19"})\n📍 ${place(req)}`);
	}
	return new Response(null, { status: 302, headers: { location: open ? FOUNDING.checkout : FOUNDING.regularCheckout, "cache-control": "no-store" } });
}
