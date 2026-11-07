// Kinetic Web accounts: sessions, Google ID token checks, the free-trial export counter, and Pro
// from a purchase (webhook) or refund. Runs on the in-memory store: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";

process.env.KINETIC_MEMORY_STORE = "1";
process.env.DODO_WEBHOOK_SECRET = `whsec_${Buffer.from("test-webhook-secret").toString("base64")}`;
const auth = await import("../api/_auth.js");
const exportApi = await import("../api/_acct-export.js");
const webhook = await import("../api/dodo-webhook.js");
const me = await import("../api/_acct-me.js");

const ORIGIN = "https://kinetic.launchloop.tech";
function req(path, { method = "POST", body, cookie } = {}) {
	return new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function signedIn(email) {
	const user = await auth.upsertUser({ sub: `test:${email}`, email });
	return `${auth.COOKIE}=${encodeURIComponent(auth.makeSession({ sub: user.sub, email: user.email }))}`;
}

test("sessions round-trip and reject tampering or expiry", () => {
	const token = auth.makeSession({ sub: "g:1", email: "a@b.co" }, 1_000);
	assert.equal(auth.readSessionToken(token, 2_000).email, "a@b.co");
	const [p, s] = token.split(".");
	const forged = Buffer.from(JSON.stringify({ sub: "g:2", email: "evil@b.co", exp: 9e15 })).toString("base64url");
	assert.equal(auth.readSessionToken(`${forged}.${s}`, 2_000), null);
	assert.equal(auth.readSessionToken(`${p}.x${s.slice(1)}`, 2_000), null);
	assert.equal(auth.readSessionToken(token, 1_000 + 31 * 86400_000), null);
});

test("Google ID tokens are checked for signature, audience, issuer, expiry and verified email", async () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
	const make = (claims, key = privateKey) => {
		const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
		const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
		return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
	};
	const good = { aud: "client-1", iss: "https://accounts.google.com", exp: 2_000, sub: "123", email: "Me@Example.com", email_verified: true, name: "Me" };
	const opts = { clientId: "client-1", keys: [jwk], now: 1_000_000 };
	const id = await auth.verifyGoogleToken(make(good), opts);
	assert.deepEqual([id.sub, id.email], ["g:123", "me@example.com"]);
	await assert.rejects(auth.verifyGoogleToken(make({ ...good, aud: "other" }), opts), /another app/);
	await assert.rejects(auth.verifyGoogleToken(make({ ...good, iss: "evil.com" }), opts), /issuer/);
	await assert.rejects(auth.verifyGoogleToken(make({ ...good, exp: 999 }), opts), /expired/);
	await assert.rejects(auth.verifyGoogleToken(make({ ...good, email_verified: false }), opts), /verified/);
	const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
	await assert.rejects(auth.verifyGoogleToken(make(good, other), opts), /signature/);
});

test("free accounts get exactly 3 exports; a refund gives one back, once", async () => {
	const cookie = await signedIn("trial@example.com");
	const start = () => exportApi.POST(req("/api/export", { body: { action: "start", aspects: ["16:9"] }, cookie }));
	const tokens = [];
	for (const left of [2, 1, 0]) {
		const r = await start();
		assert.equal(r.status, 200);
		const j = await r.json();
		assert.equal(j.left, left);
		tokens.push(j.token);
	}
	const denied = await start();
	assert.equal(denied.status, 402);
	assert.equal((await denied.json()).error.code, "trial_used");
	// Refund twice: only the first counts.
	for (let i = 0; i < 2; i++) await exportApi.POST(req("/api/export", { body: { action: "refund", token: tokens[2] }, cookie }));
	assert.equal((await start()).status, 200);
	assert.equal((await start()).status, 402);
});

test("exports need a session and a same-site request", async () => {
	assert.equal((await exportApi.POST(req("/api/export", { body: { action: "start" } }))).status, 401);
	const cookie = await signedIn("csrf@example.com");
	const cross = new Request(`${ORIGIN}/api/export`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", cookie }, body: JSON.stringify({ action: "start" }) });
	assert.equal((await exportApi.POST(cross)).status, 403);
});

function webhookRequest(event) {
	const body = JSON.stringify(event);
	const id = `msg_${Math.random().toString(36).slice(2)}`;
	const ts = String(Math.floor(Date.now() / 1000));
	const secret = Buffer.from(process.env.DODO_WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64");
	const sig = createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64");
	return new Request(`${ORIGIN}/api/dodo-webhook`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, body });
}

test("a Pro purchase makes the account with that email Pro; a refund takes it back", async () => {
	const cookie = await signedIn("buyer@example.com");
	const plan = async () => (await (await me.GET(req("/api/me", { method: "GET", cookie }))).json()).pro;
	assert.equal(await plan(), false);
	const paid = { type: "payment.succeeded", data: { payment_id: "pay_1", customer: { email: "Buyer@Example.com" }, product_cart: [{ product_id: "pdt_0NqA9CUb0BH6yLPmkMtSi" }] } };
	assert.equal((await webhook.POST(webhookRequest(paid))).status, 200);
	assert.equal(await plan(), true);
	// Pro exports are never counted against the trial.
	for (let i = 0; i < 5; i++) assert.equal((await exportApi.POST(req("/api/export", { body: { action: "start" }, cookie }))).status, 200);
	assert.equal((await webhook.POST(webhookRequest({ type: "refund.succeeded", data: { payment_id: "pay_1" } }))).status, 200);
	assert.equal(await plan(), false);
});

test("a Pipto purchase doesn't unlock Kinetic Pro", async () => {
	const cookie = await signedIn("pipto@example.com");
	const paid = { type: "payment.succeeded", data: { payment_id: "pay_2", customer: { email: "pipto@example.com" }, product_cart: [{ product_id: "pdt_0NpsOesQn6NDbtFslr82U" }] } };
	await webhook.POST(webhookRequest(paid));
	assert.equal((await (await me.GET(req("/api/me", { method: "GET", cookie }))).json()).pro, false);
});

test("a webhook with a bad signature changes nothing", async () => {
	const r = webhookRequest({ type: "payment.succeeded", data: { payment_id: "pay_3", customer: { email: "x@example.com" }, product_cart: [{ product_id: "pdt_0NqA9CUb0BH6yLPmkMtSi" }] } });
	const forged = new Request(r.url, { method: "POST", headers: { ...Object.fromEntries(r.headers), "webhook-signature": "v1,AAAA" }, body: await r.text() });
	assert.equal((await webhook.POST(forged)).status, 401);
	assert.equal(await (await import("../api/_kv.js")).redis("GET", auth.proEmailKey("x@example.com")), null);
});
