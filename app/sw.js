// Kinetic Web asset worker. The user's screenshots, logos, songs and generated scores live in the
// browser's Cache Storage under /app/k/<name>; this worker serves them, so a project's image URLs
// are ordinary same-origin paths that work in the editor, the preview iframe and the exporter,
// and survive reloads. Nothing is uploaded. Pages write the cache directly (see src/web/store.ts).
const CACHE = "kinetic-assets-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith("/app/k/") || e.request.method !== "GET") return;
	e.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const hit = await cache.match(url.pathname);
			return hit ? inert(hit) : new Response("Not found", { status: 404 });
		}),
	);
});

/** Assets are the user's files served from our own origin, so one opened as a page (an SVG with a
 *  script, an HTML file renamed .png) must not run as us. A sandboxed CSP with no script source
 *  makes any such document inert and gives it an opaque origin; nosniff stops the browser guessing
 *  a more active type. Neither header affects <img>, audio or fetch(), which is how the editor,
 *  preview and exporter use these files. */
function inert(res) {
	const headers = new Headers(res.headers);
	headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; media-src 'self'");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Cross-Origin-Resource-Policy", "same-origin");
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
