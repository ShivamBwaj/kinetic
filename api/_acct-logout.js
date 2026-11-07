// POST /api/auth/logout: end the session.
import { clearCookie, json } from "./_auth.js";

export async function POST(request) {
	return json(200, { ok: true }, { "set-cookie": clearCookie(request) });
}
