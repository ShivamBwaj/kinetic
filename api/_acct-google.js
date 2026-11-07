// POST /api/auth/google {credential}: verify a Google ID token, start a session, return /api/me.
import { fail, json, loadUser, makeSession, meFor, sameOrigin, sessionCookie, upsertUser, verifyGoogleToken } from "./_auth.js";
import { record } from "./_activity.js";
import { firstInWindow, place, sendTelegram } from "./_tg.js";

export async function POST(request) {
	if (!sameOrigin(request)) return fail(403, "Cross-site sign-in is not allowed.");
	let body;
	try {
		body = await request.json();
	} catch {
		return fail(400, "Bad request.");
	}
	let identity;
	try {
		identity = await verifyGoogleToken(body?.credential);
	} catch (e) {
		console.error("google sign-in", e.message);
		return fail(401, "Google sign-in failed. Try again.");
	}
	const isNew = !(await loadUser(identity.sub));
	const user = await upsertUser(identity);
	const req = { headers: Object.fromEntries(request.headers) };
	await record(user.sub, isNew ? "signup" : "signin", { place: place(req), ua: req.headers["user-agent"] });
	if (isNew) {
		if (firstInWindow(req, "web-signup")) await sendTelegram(`🆕 New Kinetic Web account\n📍 ${place(req)}`);
	}
	const s = { sub: user.sub, email: user.email, name: user.name, picture: user.picture };
	return json(200, await meFor(s), { "set-cookie": sessionCookie(request, makeSession(s)) });
}
