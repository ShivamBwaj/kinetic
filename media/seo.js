// Aggregate link outcomes; no cookies, query strings, link text or user identifiers.
(() => {
 const routes = new Set(["/","/templates/saas-launch","/templates/nine-beats","/templates/keynote-reveal","/templates/apple-film","/templates/agency-grade","/templates/one-shape-launch","/templates/brand-film","/templates/product-demo","/templates/use-case-blitz","/templates/business-explainer","/templates/agentic-analytics","/templates/feature-drop-ui","/templates/dev-tool-launch","/templates/neon-launch","/templates/release-hype","/templates/agent-explainer","/templates/identity-bumper","/templates/beat-square","/templates/studio-reel","/templates/designer-showreel","/templates/ui-morph-reel","/templates/dark-ui-reel","/templates/music-app","/templates/proof-in-motion","/templates/science-explainer","/templates/kinetic-text","/templates/how-to","/templates/recipe-card","/templates/spoken-word","/templates/tiny-story","/templates/company-history","/templates/history-timeline","/templates/progress-montage","/templates/waitlist-trailer","/templates/social-cut","/templates/fifteen-second-ad","/templates/hiring-film","/templates/year-in-review","/templates/metrics-flex","/templates/pricing-launch","/templates","/styles","/product-hunt-launch-video","/saas-launch-video","/app-promo-video","/vertical-launch-video","/after-effects-alternative","/pricing","/guides","/about","/research/launch-video-template-data","/download","/privacy"]);
 const source = location.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";
 if (!routes.has(source)) return;
 let landing = source;
 try {
  const saved = sessionStorage.getItem("kinetic-landing-path");
  if (routes.has(saved)) landing = saved;
  else sessionStorage.setItem("kinetic-landing-path", source);
 } catch {}
 document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a || e.defaultPrevented) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  const destination = url.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";
  const event = destination === "/buy" ? "checkout" : destination === "/download" ? "download" : "internal";
  if (destination === source || (event === "internal" && !routes.has(destination))) return;
  const data = JSON.stringify({ event, landing, source, destination });
  const body = new Blob([data], { type: "application/json" });
  if (!navigator.sendBeacon?.("/api/seo-event", body)) fetch("/api/seo-event", { method: "POST", body: data, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
 });
})();
