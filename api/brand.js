// POST /api/brand {url}: Kinetic Web's "import from URL". Reads a public page's name, icon, colours
// and words for the AI writer (the desktop app also takes screenshots; a browser can't, so web
// users add their own). Server-side because pages don't allow cross-origin reads. Guarded: http(s)
// only, no private or link-local addresses (checked on every redirect), 2 MB and 8 s limits.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fail, json, sameOrigin, session } from "./_auth.js";

const MAX_BYTES = 2_000_000;
const MAX_ICON = 400_000;

function privateAddress(ip) {
	if (isIP(ip) === 6) {
		const v = ip.toLowerCase();
		return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
	}
	const [a, b] = ip.split(".").map(Number);
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function assertPublic(url) {
	if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https pages can be read.");
	if (url.port && !["80", "443"].includes(url.port)) throw new Error("That port isn't allowed.");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (/^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new Error("That address isn't public.");
	const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
	if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error("That address isn't public.");
}

/** fetch with manual redirects, each hop checked, and a byte cap. */
async function safeFetch(raw, limit) {
	let url = new URL(raw);
	for (let hop = 0; hop < 4; hop++) {
		await assertPublic(url);
		const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; KineticBrandReader/1.0; +https://kinetic.launchloop.tech)", accept: "text/html,image/*,*/*;q=0.5" }, signal: AbortSignal.timeout(8000) });
		if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
			url = new URL(res.headers.get("location"), url);
			continue;
		}
		if (!res.ok) throw new Error(`The page answered ${res.status}.`);
		const reader = res.body?.getReader();
		const chunks = [];
		let size = 0;
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
		return { url, type: res.headers.get("content-type") ?? "", bytes: Buffer.concat(chunks) };
	}
	throw new Error("Too many redirects.");
}

const attr = (tag, name) => new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(2).find((v) => v !== undefined) ?? "";
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));

function meta(html, key) {
	for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = m[0];
		if ((attr(tag, "name") || attr(tag, "property")).toLowerCase() === key) return decode(attr(tag, "content")).trim();
	}
	return "";
}

function rgbOf(c) {
	const h = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(c.trim());
	if (!h) return null;
	const f = h[1].length === 3 ? h[1].replace(/./g, (x) => x + x) : h[1];
	return [0, 2, 4].map((i) => Number.parseInt(f.slice(i, i + 2), 16));
}
function sat([r, g, b]) {
	const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2;
	if (max === min) return { s: 0, l };
	const d = max - min;
	return { s: l > 0.5 ? d / (2 - max - min) : d / (max + min), l };
}
/** The two most-used bold colours in the page's own CSS, distinct from each other (as the desktop does). */
export function pickColors(html, theme) {
	const counts = new Map();
	for (const m of html.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)) counts.set(m[0].toLowerCase(), (counts.get(m[0].toLowerCase()) ?? 0) + 1);
	const scored = [];
	const push = (c, w) => {
		const rgb = rgbOf(c);
		if (!rgb) return;
		const { s, l } = sat(rgb);
		if (s < 0.28 || l < 0.12 || l > 0.9) return;
		scored.push({ rgb, w: w * (0.5 + s) });
	};
	if (theme) push(theme, 30);
	for (const [c, w] of counts) push(c, w);
	scored.sort((a, b) => b.w - a.w);
	const out = [];
	for (const c of scored) {
		if (out.every((o) => Math.hypot(o[0] - c.rgb[0], o[1] - c.rgb[1], o[2] - c.rgb[2]) > 90)) out.push(c.rgb);
		if (out.length === 2) break;
	}
	return out.map((rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`);
}

function cleanName(title, site, url) {
	if (site && site.length <= 30) return site;
	const parts = title.split(/\s[|\-–—·:]\s/).map((p) => p.trim()).filter(Boolean).sort((a, b) => a.length - b.length);
	if (parts[0] && parts[0].length <= 30) return parts[0];
	const host = url.hostname.replace(/^www\./, "").split(".")[0];
	return host.charAt(0).toUpperCase() + host.slice(1);
}

export async function POST(request) {
	if (!session(request)) return fail(401, "Sign in first.");
	if (!sameOrigin(request)) return fail(403, "Forbidden.");
	const body = await request.json().catch(() => ({}));
	const raw = String(body?.url ?? "").trim();
	if (!raw || raw.length > 500) return fail(400, "Enter a website address.");
	let page;
	try {
		page = await safeFetch(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`, MAX_BYTES);
	} catch (e) {
		return fail(422, `Couldn't read that page: ${e.message}`);
	}
	if (!/html/i.test(page.type)) return fail(422, "That address isn't a web page.");
	const html = page.bytes.toString("utf8");
	const title = decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").trim();
	const h1 = decode((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 140);
	const description = meta(html, "description") || meta(html, "og:description");
	const theme = meta(html, "theme-color");
	const text = decode(html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 3500);

	// Icon: SVG first, then the largest declared, then /favicon.ico.
	const icons = [...html.matchAll(/<link\b[^>]*>/gi)]
		.map((m) => m[0])
		.filter((t) => /icon/i.test(attr(t, "rel")))
		.map((t) => ({ href: attr(t, "href"), size: Number.parseInt(attr(t, "sizes")) || (/apple/i.test(attr(t, "rel")) ? 180 : 16), svg: /\.svg/i.test(attr(t, "href")) }))
		.filter((i) => i.href)
		.sort((a, b) => Number(b.svg) - Number(a.svg) || b.size - a.size);
	let logo;
	for (const i of [...icons, { href: "/favicon.ico" }].slice(0, 4)) {
		try {
			const got = await safeFetch(new URL(decode(i.href), page.url).href, MAX_ICON);
			if (got.bytes.length < 100 || !/^image\//i.test(got.type)) continue;
			logo = `data:${got.type.split(";")[0]};base64,${got.bytes.toString("base64")}`;
			break;
		} catch {
			// Try the next icon.
		}
	}
	const brand = {
		name: cleanName(title, meta(html, "og:site_name") || meta(html, "application-name"), page.url).slice(0, 40),
		colors: pickColors(html, theme || undefined),
		url: page.url.hostname.replace(/^www\./, "") + (page.url.pathname !== "/" ? page.url.pathname.replace(/\/$/, "") : ""),
	};
	return json(200, { brand, logo, pageText: [h1, description, text].filter(Boolean).join("\n").slice(0, 3500) });
}
