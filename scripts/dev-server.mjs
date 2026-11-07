// Local stand-in for Vercel: serves the site's static files and runs api/*.js the way Vercel does
// (Web-standard GET/POST/... exports, or a default (req, res) handler), with vercel.json's
// rewrites. In-memory store and dev sign-in, so no secrets are needed:
//   node scripts/dev-server.mjs            -> http://localhost:3001
// Kinetic's web app dev server (npm run web:dev in ../Kinetic) proxies /api here.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.KINETIC_MEMORY_STORE ??= "1";
process.env.KINETIC_DEV_LOGIN ??= "1";
const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 3001);
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".mp4": "video/mp4", ".xml": "application/xml" };

function rewrite(pathname) {
	// Destinations may carry a query (/api/account?r=me); the function file is the path part.
	for (const r of config.rewrites ?? []) if (r.source === pathname) return r.destination.split("?")[0];
	return pathname;
}

async function handlerFor(pathname) {
	const file = path.join(ROOT, `${pathname}.js`);
	if (!file.startsWith(path.join(ROOT, "api")) || !fs.existsSync(file)) return null;
	return import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
}

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	return Buffer.concat(chunks);
}

http
	.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const pathname = rewrite(url.pathname);
		try {
			if (pathname.startsWith("/api/")) {
				const mod = await handlerFor(pathname);
				if (!mod) return res.writeHead(404).end("no such function");
				const body = await readBody(req);
				const fn = mod[req.method];
				if (fn) {
					const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
					const out = await fn(request);
					const headers = {};
					out.headers.forEach((v, k) => (headers[k] = v));
					res.writeHead(out.status, headers);
					return res.end(Buffer.from(await out.arrayBuffer()));
				}
				if (mod.default) {
					let parsed = body.toString("utf8");
					try {
						parsed = JSON.parse(parsed);
					} catch {}
					const vreq = Object.assign(req, { body: parsed, query: Object.fromEntries(url.searchParams) });
					const vres = Object.assign(res, {
						status(c) {
							res.statusCode = c;
							return vres;
						},
						json(v) {
							res.setHeader("content-type", "application/json");
							res.end(JSON.stringify(v));
							return vres;
						},
						send(v) {
							res.end(v);
							return vres;
						},
					});
					return await mod.default(vreq, vres);
				}
				return res.writeHead(405).end();
			}
			let file = path.join(ROOT, decodeURIComponent(pathname));
			if (!file.startsWith(ROOT)) return res.writeHead(403).end();
			if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
			else if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
			if (!fs.existsSync(file)) return res.writeHead(404).end("not found");
			// vercel.json headers with exact sources (e.g. Service-Worker-Allowed on /app/sw.js).
			const extra = Object.fromEntries((config.headers ?? []).filter((h) => h.source === pathname).flatMap((h) => h.headers.map((x) => [x.key, x.value])));
			res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", ...extra });
			fs.createReadStream(file).pipe(res);
		} catch (e) {
			console.error(e);
			if (!res.headersSent) res.writeHead(500);
			res.end(String(e));
		}
	})
	.listen(PORT, () => console.log(`kinetic-web dev on http://localhost:${PORT} (memory store, dev sign-in)`));
