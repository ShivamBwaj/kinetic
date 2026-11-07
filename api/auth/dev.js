// POST /api/auth/dev {email}: local development sign-in without Google. Only when
// KINETIC_DEV_LOGIN=1 and never on Vercel production.
import { devLogin, fail, json, makeSession, meFor, sameOrigin, sessionCookie, upsertUser } from "../_auth.js";

export async function POST(request) {
	if (!devLogin()) return fail(404, "Not found.");
	if (!sameOrigin(request)) return fail(403, "Forbidden.");
	const body = await request.json().catch(() => ({}));
	const email = String(body?.email ?? "").trim().toLowerCase();
	if (!/^[^@\s]{1,64}@[^@\s]{1,120}$/.test(email)) return fail(400, "Enter an email.");
	const user = await upsertUser({ sub: `dev:${email}`, email, name: email.split("@")[0] });
	const s = { sub: user.sub, email: user.email, name: user.name };
	return json(200, await meFor(s), { "set-cookie": sessionCookie(request, makeSession(s)) });
}
