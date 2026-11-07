// Kinetic Web accounts: Google sign-in, a signed session cookie, and the account's plan.
//
// - Google: the browser gets an ID token from Google Identity Services and posts it here; it is
//   verified against Google's published keys (RS256), its audience (GOOGLE_CLIENT_ID), issuer,
//   expiry and verified email. No Google API calls on our side and no extra scopes.
// - Session: an HttpOnly, Secure, SameSite=Lax cookie holding {sub, email, name, picture, exp},
//   HMAC-SHA256 signed with SESSION_SECRET. Nothing secret is readable by page scripts.
// - Plan: Pro when the account's email bought a Kinetic Pro product (recorded by the Dodo webhook)
//   or a valid Kinetic Pro licence key is linked. Otherwise the free trial: TRIAL_EXPORTS exports.
import { createHmac, createPublicKey, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { FOUNDING, foundingSold, redis } from "./_kv.js";

export const TRIAL_EXPORTS = 3;
export const COOKIE = "kinetic_session";
const SESSION_DAYS = 30;
/** Kinetic Pro products (same list as the desktop app's licence check). */
export const PRO_PRODUCTS = ["pdt_0NqECMy1oc4IZHqFPZeFi", "pdt_0NqA9CUb0BH6yLPmkMtSi", "pdt_0NqA9CVwsSA5Jih9YKAQD", "pdt_0NqBw1PaNYaZBI4i4Xs6A"];

export const json = (status, body, headers = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
export const fail = (status, message, code) => json(status, { error: { message, ...(code ? { code } : {}) } });

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const secret = () => {
	const s = process.env.SESSION_SECRET;
	if (s && s.length >= 32) return s;
	if (process.env.VERCEL_ENV === "production") throw new Error("SESSION_SECRET is not set (32+ characters).");
	return "kinetic-dev-session-secret-not-for-production";
};
const sign = (payload) => b64url(createHmac("sha256", secret()).update(payload).digest());

export function makeSession(user, now = Date.now()) {
	const payload = b64url(JSON.stringify({ ...user, exp: now + SESSION_DAYS * 86400_000 }));
	return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token, now = Date.now()) {
	if (!token || typeof token !== "string") return null;
	const [payload, sig] = token.split(".");
	if (!payload || !sig) return null;
	const expected = Buffer.from(sign(payload));
	const given = Buffer.from(sig);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
	try {
		const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return typeof s.sub === "string" && typeof s.email === "string" && s.exp > now ? s : null;
	} catch {
		return null;
	}
}

export function cookieValue(request, name = COOKIE) {
	const raw = request.headers.get("cookie") ?? "";
	for (const part of raw.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return decodeURIComponent(v.join("="));
	}
	return null;
}

export const session = (request) => readSessionToken(cookieValue(request));

const secure = (request) => new URL(request.url).protocol === "https:";
export function sessionCookie(request, token) {
	return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(request) ? "; Secure" : ""}`;
}
export const clearCookie = (request) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(request) ? "; Secure" : ""}`;

/** Same-origin check for state-changing calls: the browser always sends Origin on POST. */
export function sameOrigin(request) {
	const origin = request.headers.get("origin");
	if (!origin) return true;
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}

// ---- Google ID tokens ---------------------------------------------------------------------------
let jwks = { at: 0, keys: [] };
async function googleKeys(fetchImpl = fetch) {
	if (Date.now() - jwks.at < 3600_000 && jwks.keys.length) return jwks.keys;
	const r = await fetchImpl("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(5000) });
	if (!r.ok) throw new Error(`Google keys ${r.status}`);
	jwks = { at: Date.now(), keys: (await r.json()).keys ?? [] };
	return jwks.keys;
}

/** The verified claims of a Google ID token, or throws. `keys` is injectable for tests. */
export async function verifyGoogleToken(token, { clientId = process.env.GOOGLE_CLIENT_ID, keys, now = Date.now() } = {}) {
	if (!clientId) throw new Error("Google sign-in is not configured.");
	const parts = String(token ?? "").split(".");
	if (parts.length !== 3) throw new Error("Malformed token.");
	const [h, p, s] = parts;
	const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
	if (header.alg !== "RS256") throw new Error("Unexpected token algorithm.");
	const jwk = (keys ?? (await googleKeys())).find((k) => k.kid === header.kid);
	if (!jwk) throw new Error("Unknown signing key.");
	const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
	if (!ok) throw new Error("Bad token signature.");
	const c = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
	if (c.aud !== clientId) throw new Error("Token is for another app.");
	if (c.iss !== "accounts.google.com" && c.iss !== "https://accounts.google.com") throw new Error("Token issuer is not Google.");
	if (!(c.exp * 1000 > now)) throw new Error("Token expired.");
	if (!c.sub || !c.email || c.email_verified !== true) throw new Error("Google account email is not verified.");
	return { sub: `g:${c.sub}`, email: String(c.email).toLowerCase(), name: c.name ? String(c.name).slice(0, 80) : undefined, picture: typeof c.picture === "string" && c.picture.startsWith("https://") ? c.picture : undefined };
}

// ---- users and plans ----------------------------------------------------------------------------
const userKey = (sub) => `kinetic:user:${sub}`;
export const trialKey = (sub) => `kinetic:trial:${sub}`;
export const proEmailKey = (email) => `kinetic:pro-email:${String(email).toLowerCase()}`;
export const linkedKey = (sub) => `kinetic:userkey:${sub}`;

export async function loadUser(sub) {
	const raw = await redis("GET", userKey(sub));
	try {
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

/** Create or refresh the account record; returns it. */
export async function upsertUser(identity) {
	const existing = await loadUser(identity.sub);
	const user = { installId: randomUUID(), createdAt: Date.now(), onboarded: false, ...existing, ...identity, seenAt: Date.now() };
	await redis("SET", userKey(identity.sub), JSON.stringify(user));
	return user;
}

export async function saveUser(user) {
	await redis("SET", userKey(user.sub), JSON.stringify(user));
}

/** Is a Kinetic Pro licence key valid? Cached for a day (same cache as the hosted writer). */
export async function licenseValid(key, fetchImpl = fetch) {
	if (!key || !/^[A-Za-z0-9-]{8,128}$/.test(key)) return false;
	const cacheKey = `kinetic:lic:${key}`;
	const cached = await redis("GET", cacheKey);
	if (cached === "1" || cached === "0") return cached === "1";
	let ok = false;
	try {
		const r = await fetchImpl("https://live.dodopayments.com/licenses/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ license_key: key }), signal: AbortSignal.timeout(6000) });
		ok = r.ok && (await r.json()).valid === true;
	} catch {
		return false;
	}
	await redis("SET", cacheKey, ok ? "1" : "0", "EX", 86400);
	return ok;
}

export async function planOf(user) {
	if (await redis("GET", proEmailKey(user.email))) return { pro: true, proSource: "purchase" };
	const key = await redis("GET", linkedKey(user.sub));
	if (key && (await licenseValid(key))) return { pro: true, proSource: "key", maskedKey: key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : "••••" };
	return { pro: false };
}

const devLogin = () => process.env.KINETIC_DEV_LOGIN === "1" && process.env.VERCEL_ENV !== "production";

/** The /api/me body for a session (or a signed-out visitor). */
export async function meFor(s) {
	let founding;
	try {
		const sold = await foundingSold();
		const open = sold < FOUNDING.cap;
		founding = { open, left: Math.max(0, FOUNDING.cap - sold), price: open ? 9 : 19, regular: 19 };
	} catch {
		founding = undefined;
	}
	const base = { googleClientId: process.env.GOOGLE_CLIENT_ID || undefined, devLogin: devLogin() || undefined, founding, trial: { used: 0, limit: TRIAL_EXPORTS } };
	if (!s) return { ...base, user: null, pro: false };
	const user = (await loadUser(s.sub)) ?? (await upsertUser({ sub: s.sub, email: s.email, name: s.name, picture: s.picture }));
	const plan = await planOf(user);
	const used = Number(await redis("GET", trialKey(user.sub))) || 0;
	return { ...base, user: { email: user.email, name: user.name, picture: user.picture }, ...plan, trial: { used, limit: TRIAL_EXPORTS }, installId: user.installId, onboarded: Boolean(user.onboarded) };
}

export { devLogin };
