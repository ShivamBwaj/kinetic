// GET /api/founding: the founding ladder for the site and the app ({ sold, cap, left, open, price }).
import { FOUNDING, foundingSold } from "./_kv.js";

export async function GET() {
	let sold = 0;
	try {
		sold = await foundingSold();
	} catch (e) {
		console.error(e);
	}
	const open = sold < FOUNDING.cap;
	return Response.json(
		{ sold: Math.min(sold, FOUNDING.cap), cap: FOUNDING.cap, left: Math.max(0, FOUNDING.cap - sold), open, price: open ? 9 : 19, regular: 19 },
		{ headers: { "cache-control": "public, s-maxage=20, stale-while-revalidate=60", "access-control-allow-origin": "*" } },
	);
}
