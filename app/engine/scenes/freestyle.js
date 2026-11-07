// Freestyle scene: a small HTML + CSS composition the AI wrote, animated by keyframes on CSS
// selectors. Authored for a 1920x1080 frame and scaled to fit. Pure function of the scene clock,
// like every scene. The script is sanitised when it's parsed; this cleans it again before it's
// put in the page, in case the editor holds raw text.
(() => {
	const S_ = (window.KineticScenes ??= {});
	const BAD_TAGS = "script,style,iframe,object,embed,link,meta,img,video,audio,source,form,input,button,a,base,template,noscript";

	const sanitize = (html) => {
		const tpl = document.createElement("template");
		tpl.innerHTML = String(html ?? "");
		for (const n of tpl.content.querySelectorAll(BAD_TAGS)) n.remove();
		for (const n of tpl.content.querySelectorAll("*"))
			for (const a of [...n.attributes]) {
				const k = a.name.toLowerCase();
				if (k.startsWith("on") || k === "href" || k === "src" || k === "srcset" || /javascript:|url\s*\(/i.test(a.value)) n.removeAttribute(a.name);
			}
		return tpl.content;
	};
	/** Scope every rule to this scene's box, and drop anything that could load or run something. */
	const scopeCss = (css, scope) =>
		String(css ?? "")
			.replace(/@(import|font-face|charset|namespace)[^;{]*(;|\{[^}]*\})/gi, "")
			.replace(/url\s*\([^)]*\)/gi, "none")
			.replace(/<\/?\w[^>]*>/g, "")
			.replace(/(^|\})\s*([^{}@]+)\{/g, (m, close, sel) => `${close} ${sel.split(",").map((x) => `${scope} ${x.trim()}`).join(", ")} {`);

	const EASE = {
		linear: (t) => t,
		out: (t) => 1 - (1 - t) ** 3,
		inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
	};

	S_.freestyle = ({ p, cam, K }) => {
		const { W, H, el, set, clamp, spring } = K;
		const s = p.scene;
		const id = `fs${p.index}`;
		const k = Math.min(W / 1920, H / 1080);
		const box = el("div", "", cam);
		box.id = id;
		set(box, { position: "absolute", width: "1920px", height: "1080px", left: `${(W - 1920 * k) / 2}px`, top: `${(H - 1080 * k) / 2}px`, transform: `scale(${k})`, transformOrigin: "0 0", overflow: "visible" });
		const style = document.createElement("style");
		style.textContent = scopeCss(s.css, `#${id}`);
		box.appendChild(style);
		box.appendChild(sanitize(s.html));
		const tracks = (s.keys ?? []).map((key) => {
			let nodes = [];
			try {
				nodes = [...box.querySelectorAll(key.sel)];
			} catch {}
			return { key, nodes };
		});
		const val = (v, a, b, e) => (a == null && b == null ? undefined : (a ?? b) + ((b ?? a) - (a ?? b)) * e);
		return (l, d) => {
			// Every node a track touches gets its values from the last track that has started on it.
			const state = new Map();
			for (const { key, nodes } of tracks) {
				nodes.forEach((n, i) => {
					const start = (key.at + (key.stagger ?? 0) * i) * d;
					const len = Math.max(0.01, key.dur * d);
					const t = clamp((l - start) / len);
					const e = key.ease === "spring" ? spring(l - start, 1.6 / len, 0.55) : (EASE[key.ease] ?? EASE.out)(t);
					const cur = state.get(n) ?? {};
					for (const prop of ["opacity", "x", "y", "scale", "rotate", "blur", "clip"]) {
						const v = val(null, key.from?.[prop], key.to?.[prop], e);
						if (v !== undefined && (l >= start || cur[prop] === undefined)) cur[prop] = v;
					}
					state.set(n, cur);
				});
			}
			for (const [n, v] of state) {
				set(n, {
					opacity: v.opacity === undefined ? "" : String(Math.max(0, Math.min(1, v.opacity))),
					transform: `translate(${(v.x ?? 0).toFixed(2)}px, ${(v.y ?? 0).toFixed(2)}px) scale(${(v.scale ?? 1).toFixed(4)}) rotate(${(v.rotate ?? 0).toFixed(3)}deg)`,
					filter: v.blur ? `blur(${Math.max(0, v.blur).toFixed(2)}px)` : "",
					clipPath: v.clip === undefined ? "" : `inset(0 ${(100 - Math.max(0, Math.min(100, v.clip))).toFixed(2)}% 0 0)`,
				});
			}
		};
	};
})();
