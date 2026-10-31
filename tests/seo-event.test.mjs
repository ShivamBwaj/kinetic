import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/seo-event.js";

function request(body, headers = {}, method = "POST") {
	return { method, body, headers: { origin: "https://kinetic.launchloop.tech", "user-agent": "Mozilla/5.0", "x-forwarded-for": "192.0.2.1", ...headers } };
}
function response() {
	return { code: 0, setHeader() {}, status(code) { this.code = code; return this; }, end() { return this; } };
}

test("accepts only known routes and event destinations", async () => {
	const valid = { event: "internal", landing: "/", source: "/guides", destination: "/pricing" };
	for (const body of [null, "invalid JSON", { ...valid, event: "sale" }, { ...valid, source: "/customer/alice@example.com" }, { ...valid, landing: "/?email=private" }, { ...valid, destination: "/guides" }, { ...valid, event: "checkout", destination: "/guides" }, { ...valid, event: "download", destination: "/buy" }]) {
		const res = response(); await handler(request(body), res); assert.equal(res.code, 400);
	}
	const res = response(); await handler(request(valid, { origin: "https://unrelated.example" }), res); assert.equal(res.code, 403);
	const get = response(); await handler(request(valid, {}, "GET"), get); assert.equal(get.code, 405);
});

test("stores only aggregate path counters and suppresses repeated events", async () => {
	const calls = [];
	const original = globalThis.fetch;
	process.env.KV_REST_API_URL = "https://store.invalid";
	process.env.KV_REST_API_TOKEN = "test-only";
	globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ result: 1 }) }; };
	try {
		const body = { event: "checkout", landing: "/guides", source: "/pricing", destination: "/buy", email: "discard@example.com", prompt: "discard this" };
		for (let i = 0; i < 2; i++) { const res = response(); await handler(request(body), res); assert.equal(res.code, 204); }
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0].slice(2), ["checkout|/guides|/pricing|/buy", "1"]);
		assert.deepEqual(calls[1].slice(2), [String(120 * 86400)]);
		assert(!JSON.stringify(calls).includes("discard"));
	} finally { globalThis.fetch = original; delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; }
});

test("bots and store outages do not break navigation", async () => {
	const body = { event: "download", landing: "/", source: "/pricing", destination: "/download" };
	const bot = response(); await handler(request(body, { "user-agent": "Googlebot" }), bot); assert.equal(bot.code, 204);
	const res = response(); await handler(request(body), res); assert.equal(res.code, 204);
});
