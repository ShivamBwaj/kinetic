// GET /api/me: the signed-in account, its plan and free-trial count (or a signed-out shell).
// POST /api/me {onboarded: true}: the account finished onboarding.
import { record } from "./_activity.js";
import { fail, json, loadUser, meFor, sameOrigin, saveUser, session } from "./_auth.js";

export async function GET(request) {
	try {
		return json(200, await meFor(session(request)));
	} catch (e) {
		console.error("me", e);
		return fail(503, "Kinetic's account service is unavailable. Try again in a minute.");
	}
}

export async function POST(request) {
	const s = session(request);
	if (!s) return fail(401, "Sign in first.");
	if (!sameOrigin(request)) return fail(403, "Forbidden.");
	const body = await request.json().catch(() => ({}));
	const user = await loadUser(s.sub);
	if (user && body?.onboarded === true && !user.onboarded) {
		await saveUser({ ...user, onboarded: true });
		await record(s.sub, "onboarded");
	}
	return json(200, await meFor(s));
}
