// UI scenes: code typing, a chat thread, notifications, a macOS dock, tab chaos, a laptop, a
// browser, a card with callouts, and before/after. Pure functions of the scene clock.
(() => {
	const S_ = (window.KineticScenes ??= {});

	// ---- code -------------------------------------------------------------------------------
	const KEYWORDS = /\b(import|from|export|const|let|var|function|return|await|async|if|else|for|while|new|class|def|print|true|false|null|undefined)\b/g;
	/** Minimal syntax colouring: strings, comments, numbers, keywords. Returns [text, colour] runs. */
	const tokenize = (line, theme) => {
		const runs = [];
		const re = /(\/\/.*$|#.*$|"[^"]*"|'[^']*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|\s+|.)/g;
		for (const m of line.matchAll(re)) {
			const t = m[0];
			let c = theme.text;
			if (/^(\/\/|#)/.test(t)) c = theme.comment;
			else if (/^["'`]/.test(t)) c = theme.string;
			else if (/^\d/.test(t)) c = theme.number;
			else if (KEYWORDS.test(t)) c = theme.keyword;
			KEYWORDS.lastIndex = 0;
			runs.push([t, c]);
		}
		return runs;
	};
	S_.code = ({ p, cam, accent, K }) => {
		const { W, H, S, el, set, px, spring, clamp, hash } = K;
		const s = p.scene;
		const vertical = H > W * 1.2;
		const theme = { bg: "#0f1117", bar: "#171a22", text: "#e6e8ef", comment: "#6b7280", string: "#a5e36b", number: "#ffb86b", keyword: "#ff6bb0" };
		const ww = vertical ? W * 0.9 : W * 0.66;
		const longest = Math.max(...s.lines.map((x) => x.length), 18);
		const fs = Math.min(46 * S, (ww - 160 * S) / (longest * 0.62));
		const win = el("div", "card", cam);
		set(win, { width: px(ww), left: px((W - ww) / 2), background: theme.bg, borderRadius: px(22 * S), boxShadow: `0 ${px(50 * S)} ${px(120 * S)} rgba(0,0,0,0.45), 0 0 0 ${px(1.5 * S)} rgba(255,255,255,0.06)`, fontFamily: '"Geist Mono", monospace', color: theme.text });
		const bar = el("div", "", win);
		set(bar, { height: px(64 * S), background: theme.bar, display: "flex", alignItems: "center", gap: px(12 * S), padding: `0 ${px(26 * S)}` });
		for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
			const d = el("div", "", bar);
			set(d, { width: px(18 * S), height: px(18 * S), borderRadius: "50%", background: c });
		}
		const title = el("div", "", bar, s.title ?? "index.ts");
		set(title, { marginLeft: px(16 * S), fontSize: px(24 * S), color: "#9aa0ad" });
		const body = el("div", "", win);
		set(body, { padding: `${px(34 * S)} ${px(40 * S)}`, fontSize: px(fs), lineHeight: "1.6", whiteSpace: "pre" });
		const rows = s.lines.map((text, i) => {
			const r = el("div", "", body);
			set(r, { display: "flex", minHeight: "1.6em" });
			const no = el("span", "", r, String(i + 1).padStart(2, " "));
			set(no, { color: "#4b5160", marginRight: "1.2em", flex: "none" });
			const code = el("span", "", r);
			const spans = tokenize(text, theme).map(([t, c]) => {
				const sp = el("span", "", code);
				sp.style.color = c;
				return { sp, t };
			});
			return { spans, len: text.length };
		});
		const caret = el("span", "caret", body);
		set(caret, { width: "0.55em", height: "1.15em", background: accent, position: "absolute" });
		const total = rows.reduce((a, r) => a + r.len, 0) || 1;
		const hgt = win.offsetHeight;
		const typeEnd = p.dur * 0.82;
		return (l) => {
			const e = spring(l, 2.2, 0.7);
			set(win, { top: px((H - hgt) / 2), transform: `perspective(${px(2400 * S)}) rotateX(${((1 - e) * 22).toFixed(2)}deg) translateY(${px((1 - e) * 120 * S)})`, opacity: clamp(l / 0.1).toFixed(3) });
			// Characters typed so far, with a little rhythm.
			let budget = Math.floor(clamp((l - 0.25) / Math.max(0.3, typeEnd - 0.25)) * total + hash(Math.floor(l * 12)) * 0.5);
			let caretAt = null;
			for (const r of rows) {
				for (const { sp, t } of r.spans) {
					const n = Math.max(0, Math.min(t.length, budget));
					const txt = t.slice(0, n);
					if (sp.textContent !== txt) sp.textContent = txt;
					budget -= t.length;
					if (n > 0 && n <= t.length) caretAt = sp;
				}
			}
			if (caretAt) {
				const rr = caretAt.getBoundingClientRect();
				const br = body.getBoundingClientRect();
				const sc = br.width / body.offsetWidth || 1;
				set(caret, { left: px((rr.right - br.left) / sc + 34 * S + 4 * S), top: px((rr.top - br.top) / sc + 34 * S), opacity: Math.floor(l * 3) % 2 && l > typeEnd ? "0" : "1" });
			}
		};
	};

	// ---- chat -------------------------------------------------------------------------------
	S_.chat = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, spring, clamp, textOn, alpha, prog, expoOut } = K;
		const s = p.scene;
		const marks = p.marks ?? s.messages.map((_, i) => 0.2 + i * p.beatLen * 1.5);
		const vertical = H > W * 1.2;
		const colW = vertical ? W * 0.86 : Math.min(W * 0.5, 980 * S);
		const col = el("div", "", cam);
		set(col, { position: "absolute", left: px((W - colW) / 2), width: px(colW), display: "flex", flexDirection: "column", gap: px(22 * S) });
		const them = alpha(fg, 0.1);
		const bubbles = s.messages.map((m) => {
			const row = el("div", "", col);
			set(row, { display: "flex", justifyContent: m.me ? "flex-end" : "flex-start" });
			const b = el("div", "", row, m.text);
			set(b, { maxWidth: "78%", padding: `${px(24 * S)} ${px(34 * S)}`, borderRadius: px(40 * S), fontSize: px(46 * S), fontWeight: "520", letterSpacing: "-0.015em", lineHeight: "1.25", background: m.me ? accent : them, color: m.me ? textOn(accent) : fg, transformOrigin: m.me ? "100% 100%" : "0 100%" });
			// Typing dots before their messages.
			let dots = null;
			if (!m.me) {
				dots = el("div", "", row);
				set(dots, { position: "absolute", padding: `${px(26 * S)} ${px(30 * S)}`, borderRadius: px(40 * S), background: them, display: "flex", gap: px(10 * S) });
				for (let i = 0; i < 3; i++) {
					const d = el("div", "", dots);
					set(d, { width: px(16 * S), height: px(16 * S), borderRadius: "50%", background: alpha(fg, 0.55) });
				}
			}
			return { row, b, dots };
		});
		const heights = bubbles.map((x) => x.row.offsetHeight + 22 * S);
		return (l) => {
			let shown = 0;
			bubbles.forEach(({ row, b, dots }, i) => {
				const at = marks[i];
				const typing = dots && l >= at - 0.45 && l < at;
				const k = spring(l - at, 3, 0.55);
				const on = l >= at;
				set(row, { display: on || typing ? "flex" : "none" });
				set(b, { visibility: on ? "visible" : "hidden", transform: `scale(${(0.5 + 0.5 * k).toFixed(4)})`, opacity: clamp((l - at) / 0.06).toFixed(3) });
				if (dots) {
					set(dots, { opacity: typing ? "1" : "0" });
					[...dots.children].forEach((d, j) => set(d, { transform: `translateY(${px(Math.sin(l * 14 - j) * 5 * S)})` }));
				}
				if (on || typing) shown += heights[i] * (on ? expoOut(prog(l, at, 0.3)) : 1);
			});
			set(col, { top: px(H / 2 - shown / 2) });
		};
	};

	// ---- notifications ------------------------------------------------------------------------
	S_.notify = ({ p, cam, fg, palette, K }) => {
		const { W, H, S, el, set, px, spring, clamp, textOn, lum } = K;
		const s = p.scene;
		const marks = p.marks ?? s.items.map((_, i) => 0.15 + i * p.beatLen);
		const vertical = H > W * 1.2;
		const w = vertical ? W * 0.88 : Math.min(W * 0.46, 900 * S);
		const dark = lum(fg) > 0.5;
		const colors = [palette.electric, palette.coral, palette.lime, palette.peach, palette.sage];
		const cards = s.items.map((it, i) => {
			const c = el("div", "", cam);
			set(c, { position: "absolute", left: px((W - w) / 2), width: px(w), boxSizing: "border-box", padding: px(28 * S), borderRadius: px(36 * S), background: dark ? "rgba(40,40,46,0.82)" : "rgba(255,255,255,0.86)", backdropFilter: `blur(${px(20 * S)})`, boxShadow: `0 ${px(24 * S)} ${px(60 * S)} rgba(0,0,0,0.18)`, display: "flex", gap: px(24 * S), alignItems: "center", color: dark ? "#fff" : "#111" });
			const ic = el("div", "", c, it.app.charAt(0).toUpperCase());
			const col = colors[i % colors.length];
			set(ic, { width: px(84 * S), height: px(84 * S), borderRadius: px(20 * S), background: col, color: textOn(col), display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "800", fontSize: px(40 * S), flex: "none" });
			const txt = el("div", "", c);
			set(txt, { flex: "1", minWidth: "0" });
			const top = el("div", "", txt);
			set(top, { display: "flex", justifyContent: "space-between", fontSize: px(26 * S), opacity: "0.6", fontWeight: "560" });
			el("span", "", top, it.app.toUpperCase());
			el("span", "", top, "now");
			const t = el("div", "", txt, it.title);
			set(t, { fontSize: px(38 * S), fontWeight: "700", letterSpacing: "-0.015em", marginTop: px(4 * S) });
			if (it.body) {
				const b = el("div", "", txt, it.body);
				set(b, { fontSize: px(32 * S), opacity: "0.8", marginTop: px(2 * S) });
			}
			return c;
		});
		const hs = cards.map((c) => c.offsetHeight + 18 * S);
		return (l) => {
			// Newest on top: each arrival pushes the stack down.
			let y = H * 0.5 - hs.reduce((a, b) => a + b, 0) / 2;
			const order = cards.map((_, i) => i).reverse();
			let offset = 0;
			for (const i of order) {
				const k = spring(l - marks[i], 2.8, 0.62);
				const on = l >= marks[i];
				set(cards[i], { top: px(y + offset), transform: `translateY(${px((1 - k) * -H * 0.35)}) scale(${(0.92 + 0.08 * k).toFixed(4)})`, opacity: on ? clamp((l - marks[i]) / 0.08).toFixed(3) : "0" });
				if (on) offset += hs[i] * Math.min(1, k);
			}
			y += 0;
		};
	};

	// ---- dock ---------------------------------------------------------------------------------
	S_.dock = ({ p, cam, fg, accent, palette, K }) => {
		const { W, H, S, el, set, px, spring, clamp, textOn, lerp, cubicInOut, prog, expoIn, makeCursor, images, plan, fit } = K;
		const s = p.scene;
		const n = s.apps.length;
		const open = Math.min(n - 1, s.open ?? Math.floor(n / 2));
		const base = 120 * S * (W > H ? 1 : 0.9);
		const gap = 18 * S;
		const dockW = n * base + (n + 1) * gap;
		const bar = el("div", "", cam);
		set(bar, { position: "absolute", left: px((W - dockW) / 2), top: px(H * 0.62), width: px(dockW), height: px(base + gap * 2), borderRadius: px(36 * S), background: "rgba(255,255,255,0.22)", backdropFilter: `blur(${px(24 * S)})`, border: `${px(1.5 * S)} solid rgba(255,255,255,0.35)`, boxShadow: `0 ${px(30 * S)} ${px(80 * S)} rgba(0,0,0,0.25)` });
		const cols = [palette.electric, palette.lime, palette.coral, palette.peach, palette.sage, palette.lilac, palette.butter, palette.ink];
		const logo = plan.brand?.logo ? images[plan.brand.logo] : null;
		const icons = s.apps.map((a, i) => {
			const ic = el("div", "", cam);
			const col = a === "★" ? palette.brand : cols[i % cols.length];
			set(ic, { position: "absolute", width: px(base), height: px(base), borderRadius: px(base * 0.23), background: col, display: "flex", alignItems: "center", justifyContent: "center", fontSize: px(base * 0.5), color: textOn(col), fontWeight: "800", boxShadow: `0 ${px(8 * S)} ${px(18 * S)} rgba(0,0,0,0.2)`, transformOrigin: "50% 100%" });
			if (a === "★" && logo) {
				const im = el("img", "", ic);
				im.src = logo.src;
				set(im, { width: "70%", height: "70%", objectFit: "contain" });
			} else ic.textContent = a === "★" ? (plan.brand?.name ?? "K").charAt(0) : a;
			return { ic, col };
		});
		let cap = null;
		if (s.caption) {
			cap = el("div", "display", cam, s.caption);
			set(cap, { position: "absolute", left: "0", right: "0", top: px(H * 0.2), textAlign: "center", color: fg, margin: "0 auto" });
			fit(cap, W * 0.84, H * 0.2, 130 * S);
		}
		const cursor = makeCursor(cam, 70 * S);
		const sweepEnd = p.dur * 0.5;
		const clickAt = p.dur * 0.58;
		const centers = icons.map((_, i) => (W - dockW) / 2 + gap + i * (base + gap) + base / 2);
		const dockY = H * 0.62 + gap + base / 2;
		return (l) => {
			// The cursor sweeps left to right, then comes back to the app it opens.
			const sweep = cubicInOut(prog(l, 0.1, sweepEnd - 0.1));
			const back = cubicInOut(prog(l, sweepEnd, clickAt - sweepEnd - 0.05));
			const mx = lerp(lerp(centers[0] - base, centers[n - 1] + base * 0.5, sweep), centers[open], back);
			let x = (W - dockW) / 2 + gap;
			const scales = icons.map((_, i) => 1 + 0.75 * Math.exp(-(((centers[i] - mx) / (base * 1.25)) ** 2)) * clamp(l / 0.2));
			const total = scales.reduce((a, k) => a + k * base, 0) + (n - 1) * gap;
			x = W / 2 - total / 2;
			icons.forEach(({ ic }, i) => {
				const k = scales[i];
				const bounce = i === open && l > clickAt ? Math.abs(Math.sin((l - clickAt) * 9)) * Math.exp(-(l - clickAt) * 3) * 50 * S : 0;
				set(ic, { left: px(x), top: px(dockY + base / 2 - base * k - bounce), width: px(base * k), height: px(base * k), fontSize: px(base * 0.5 * k), borderRadius: px(base * 0.23 * k) });
				x += base * k + gap;
			});
			set(bar, { left: px(W / 2 - total / 2 - gap), width: px(total + gap * 2) });
			cursor(l, { fx: mx, fy: dockY + base * 0.35, x: mx, y: dockY + base * 0.35, start: 0.1, arrive: 0.11, click: clickAt });
			// Then the camera dives into the opened app until its colour fills the frame.
			const dive = expoIn(prog(l, clickAt + 0.25, p.dur - clickAt - 0.25));
			const z = 1 + dive * 14;
			const fx = centers[open];
			const fy = dockY;
			set(cam, { transform: `translate(${px(W / 2 - fx * z + (fx - W / 2) * (1 - dive))}, ${px(H / 2 - fy * z + (fy - H / 2) * (1 - dive))}) scale(${z.toFixed(4)})` });
			if (cap) set(cap, { opacity: (clamp(l / 0.2) * (1 - dive)).toFixed(3) });
			void spring;
			void accent;
		};
	};

	// ---- tab chaos ------------------------------------------------------------------------------
	S_.chaos = ({ p, cam, fg, palette, K }) => {
		const { W, H, S, el, set, px, fit, spring, clamp, hash, images, alpha, expoOut, prog } = K;
		const s = p.scene;
		const imgs = (s.images ?? []).map((u) => images[u]).filter(Boolean);
		const n = 14;
		const cols = [palette.electric, palette.coral, palette.lime, palette.peach, palette.sage, palette.butter];
		const wins = Array.from({ length: n }, (_, i) => {
			const w = (0.16 + hash(i * 2.1) * 0.1) * W;
			const h = w * 0.66;
			const ang = (i / n) * Math.PI * 2 + hash(i) * 0.6;
			const rad = 0.3 + hash(i * 4.4) * 0.16;
			const x = W / 2 + Math.cos(ang) * W * rad - w / 2;
			const y = H / 2 + Math.sin(ang) * H * (rad + 0.08) - h / 2;
			const c = el("div", "card", cam);
			set(c, { left: px(x), top: px(y), width: px(w), height: px(h), borderRadius: px(12 * S), boxShadow: `0 ${px(20 * S)} ${px(50 * S)} rgba(0,0,0,0.18)`, background: "#fff" });
			const bar = el("div", "", c);
			set(bar, { height: px(h * 0.12), background: "#eceae6", display: "flex", alignItems: "center", gap: px(5 * S), padding: `0 ${px(10 * S)}` });
			for (const d of ["#ff5f57", "#febc2e", "#28c840"]) {
				const dd = el("div", "", bar);
				set(dd, { width: px(8 * S), height: px(8 * S), borderRadius: "50%", background: d });
			}
			const img = imgs.length ? imgs[i % imgs.length] : null;
			if (img) {
				const im = el("img", "fill", c);
				im.src = img.src;
				set(im, { height: "88%" });
			} else {
				const body = el("div", "", c);
				set(body, { padding: px(12 * S), display: "grid", gridTemplateColumns: "1fr 1fr", gap: px(8 * S) });
				for (let j = 0; j < 4; j++) {
					const b = el("div", "", body);
					set(b, { height: px(h * 0.28), borderRadius: px(6 * S), background: j === 0 ? cols[i % cols.length] : alpha("#000000", 0.07) });
				}
			}
			return { c, at: 0.1 + (i / n) * p.dur * 0.6, rot: (hash(i * 9.9) - 0.5) * 24, dx: Math.cos(ang), dy: Math.sin(ang) };
		});
		const text = el("div", "bold", cam, s.text);
		set(text, { position: "absolute", left: "0", right: "0", textAlign: "center", color: fg, zIndex: "5", margin: "0 auto" });
		fit(text, W * 0.5, H * 0.18, 90 * S);
		const th = text.offsetHeight;
		return (l) => {
			for (const w of wins) {
				const k = spring(l - w.at, 2.6, 0.6);
				const on = l >= w.at;
				set(w.c, { opacity: on ? clamp((l - w.at) / 0.06).toFixed(3) : "0", transform: `translate(${px((1 - k) * w.dx * W * 0.5)}, ${px((1 - k) * w.dy * H * 0.5)}) rotate(${(w.rot * (0.4 + 0.6 * k)).toFixed(2)}deg) scale(${(0.6 + 0.4 * k).toFixed(4)})` });
			}
			const tk = expoOut(prog(l, 0.02, 0.5));
			set(text, { top: px(H / 2 - th / 2), opacity: tk.toFixed(3), transform: `scale(${(0.9 + 0.1 * tk).toFixed(4)})` });
		};
	};

	// ---- devices ------------------------------------------------------------------------------
	S_.laptop = ({ p, cam, fg, accent, palette, K }) => {
		const { W, H, S, el, set, px, fit, spring, clamp, expoInOut, prog, images, mockUI, lerp } = K;
		const s = p.scene;
		const img = s.image ? images[s.image] : null;
		const vertical = H > W * 1.2;
		const sw = vertical ? W * 0.84 : W * (s.caption ? 0.48 : 0.56);
		const sh = sw * 0.625;
		const top = H * (s.caption ? (vertical ? 0.3 : 0.27) : 0.18);
		const lid = el("div", "", cam);
		set(lid, { position: "absolute", left: px((W - sw) / 2 - sw * 0.03), top: px(top), width: px(sw * 1.06), height: px(sh * 1.08), borderRadius: px(sw * 0.03), background: "#1b1c1f", boxShadow: `0 0 0 ${px(2 * S)} #3a3b40 inset` });
		const screen = el("div", "card", lid);
		set(screen, { left: px(sw * 0.03), top: px(sh * 0.04), width: px(sw), height: px(sh), borderRadius: px(sw * 0.008) });
		if (img) {
			const im = el("img", "fill", screen);
			im.src = img.src;
		} else mockUI(screen, palette, accent, p.index);
		const baseW = sw * 1.32;
		const baseEl = el("div", "", cam);
		set(baseEl, { position: "absolute", left: px((W - baseW) / 2), top: px(top + sh * 1.08), width: px(baseW), height: px(sw * 0.035), background: "linear-gradient(#c9cbd1, #9a9ca3)", borderRadius: `0 0 ${px(sw * 0.04)} ${px(sw * 0.04)}`, boxShadow: `0 ${px(30 * S)} ${px(60 * S)} rgba(0,0,0,0.25)` });
		let cap = null;
		if (s.caption) {
			cap = el("div", "display", cam, s.caption);
			set(cap, { position: "absolute", left: "0", right: "0", top: px(H * 0.07), textAlign: "center", color: fg, margin: "0 auto" });
			fit(cap, W * 0.84, H * 0.16, 130 * S);
		}
		const scx = W / 2;
		const scy = top + sh * 0.04 + sh / 2;
		const zMax = Math.min(W / sw, H / sh) * 1.02;
		return (l) => {
			const e = spring(l, 2, 0.75);
			const dive = expoInOut(prog(l, p.dur * 0.5, p.dur * 0.45));
			const z = lerp(0.8 + 0.2 * e, zMax, dive);
			const cx = lerp(W / 2, scx, dive);
			const cy = lerp(H / 2, scy, dive);
			set(cam, { transform: `translate(${px(W / 2 - cx * z)}, ${px(H / 2 - cy * z)}) scale(${z.toFixed(4)})` });
			set(lid, { opacity: clamp(l / 0.1).toFixed(3) });
			if (cap) set(cap, { opacity: (clamp(l / 0.2) * (1 - dive)).toFixed(3) });
		};
	};

	S_.browser = ({ p, cam, fg, accent, palette, K }) => {
		const { W, H, S, el, set, px, spring, clamp, prog, expoOut, images, mockUI, lerp, cubicInOut } = K;
		const s = p.scene;
		const img = s.image ? images[s.image] : null;
		const vertical = H > W * 1.2;
		const ww = vertical ? W * 0.92 : W * 0.74;
		const wh = vertical ? H * 0.6 : ww * 0.6;
		const win = el("div", "card", cam);
		set(win, { left: px((W - ww) / 2), top: px((H - wh) / 2), width: px(ww), height: px(wh), borderRadius: px(18 * S), background: "#ffffff", boxShadow: `0 ${px(50 * S)} ${px(110 * S)} rgba(0,0,0,0.28)` });
		const bar = el("div", "", win);
		set(bar, { height: px(86 * S), background: "#efedea", display: "flex", alignItems: "center", gap: px(12 * S), padding: `0 ${px(26 * S)}` });
		for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
			const d = el("div", "", bar);
			set(d, { width: px(18 * S), height: px(18 * S), borderRadius: "50%", background: c, flex: "none" });
		}
		const url = el("div", "", bar);
		set(url, { flex: "1", marginLeft: px(20 * S), height: px(52 * S), borderRadius: px(26 * S), background: "#ffffff", display: "flex", alignItems: "center", padding: `0 ${px(26 * S)}`, fontSize: px(30 * S), color: "#222", fontWeight: "500" });
		const lock = el("span", "", url, "🔒 ");
		set(lock, { fontSize: px(22 * S), marginRight: px(8 * S) });
		const typed = el("span", "", url);
		const caret = el("span", "caret", url);
		set(caret, { width: px(3 * S), height: px(32 * S), background: accent, marginLeft: px(3 * S) });
		const loadBar = el("div", "", win);
		set(loadBar, { height: px(5 * S), background: accent, width: "0" });
		const page = el("div", "", win);
		set(page, { position: "absolute", left: "0", right: "0", top: px(91 * S), bottom: "0", overflow: "hidden" });
		if (img) {
			const im = el("img", "fill", page);
			im.src = img.src;
		} else mockUI(page, palette, accent, p.index);
		const typeEnd = p.dur * 0.42;
		const loadAt = typeEnd + 0.12;
		return (l) => {
			const e = spring(l, 2.2, 0.7);
			set(win, { transform: `scale(${(0.88 + 0.12 * e).toFixed(4)})`, opacity: clamp(l / 0.1).toFixed(3) });
			const n = Math.round(clamp((l - 0.15) / Math.max(0.2, typeEnd - 0.15)) * s.url.length);
			typed.textContent = s.url.slice(0, n);
			set(caret, { opacity: l < loadAt ? "1" : "0" });
			const lk = prog(l, loadAt, 0.5);
			set(loadBar, { width: `${(cubicInOut(lk) * 100).toFixed(1)}%`, opacity: lk >= 1 ? "0" : "1" });
			const pk = expoOut(prog(l, loadAt + 0.25, 0.6));
			set(page, { opacity: pk.toFixed(3), transform: `translateY(${px((1 - pk) * 60 * S)})` });
			void lerp;
		};
	};

	/** A product card with tooltip callouts popping out beside it on the beat. */
	S_.callouts = ({ p, cam, fg, accent, palette, K }) => {
		const { W, H, S, el, set, px, fit, spring, clamp, images, mockUI, alpha, expoOut, prog } = K;
		const s = p.scene;
		const marks = p.marks ?? s.notes.map((_, i) => 0.55 + i * p.beatLen);
		const img = s.image ? images[s.image] : null;
		const vertical = H > W * 1.2;
		let title = null;
		if (s.title) {
			title = el("div", "bold", cam, s.title);
			set(title, { position: "absolute", left: "0", right: "0", top: px(H * 0.07), textAlign: "center", color: fg, fontWeight: "650", margin: "0 auto" });
			fit(title, W * 0.8, H * 0.1, 64 * S);
		}
		const aspect = img ? img.w / img.h : 0.78;
		let ch = H * (vertical ? 0.46 : 0.66);
		let cw = ch * aspect;
		if (cw > W * (vertical ? 0.86 : 0.5)) {
			cw = W * (vertical ? 0.86 : 0.5);
			ch = cw / aspect;
		}
		const cx = vertical ? (W - cw) / 2 : W * 0.4 - cw / 2;
		const cy = H * (s.title ? 0.2 : 0.17);
		const card = el("div", "card", cam);
		set(card, { left: px(cx), top: px(cy), width: px(cw), height: px(ch), borderRadius: px(20 * S), boxShadow: `0 ${px(40 * S)} ${px(90 * S)} rgba(0,0,0,0.24)` });
		if (img) {
			const im = el("img", "fill", card);
			im.src = img.src;
		} else mockUI(card, palette, accent, p.index);
		const notes = s.notes.map((text, i) => {
			const ny = cy + ch * (0.18 + i * (0.64 / Math.max(1, s.notes.length - 1 || 1)));
			const nx = vertical ? W * 0.08 + (i % 2) * W * 0.36 : cx + cw + 60 * S;
			const top = vertical ? cy + ch + 40 * S + Math.floor(i / 2) * 110 * S : ny - 40 * S;
			const line = el("div", "", cam);
			set(line, { position: "absolute", left: px(cx + cw - 16 * S), top: px(ny), height: px(3 * S), width: px(76 * S), background: alpha(fg, 0.35), transformOrigin: "0 50%", display: vertical ? "none" : "block" });
			const dot = el("div", "", cam);
			set(dot, { position: "absolute", left: px(cx + cw - 24 * S), top: px(ny - 8 * S), width: px(16 * S), height: px(16 * S), borderRadius: "50%", background: accent, boxShadow: `0 0 0 ${px(6 * S)} ${alpha(accent, 0.25)}`, display: vertical ? "none" : "block" });
			const pill = el("div", "", cam, text);
			set(pill, { position: "absolute", left: px(nx), top: px(top), padding: `${px(20 * S)} ${px(30 * S)}`, borderRadius: px(22 * S), background: "#ffffff", color: "#15161a", fontWeight: "620", fontSize: px(36 * S), letterSpacing: "-0.015em", whiteSpace: "nowrap", boxShadow: `0 ${px(18 * S)} ${px(46 * S)} rgba(0,0,0,0.16)`, transformOrigin: "0 50%" });
			return { line, dot, pill };
		});
		return (l) => {
			const e = spring(l, 2.2, 0.7);
			set(card, { opacity: clamp(l / 0.1).toFixed(3), transform: `translateY(${px((1 - e) * 120 * S)}) rotate(${((1 - e) * -3).toFixed(2)}deg)` });
			if (title) set(title, { opacity: clamp(l / 0.2).toFixed(3) });
			notes.forEach(({ line, dot, pill }, i) => {
				const k = spring(l - marks[i], 3, 0.55);
				const on = l >= marks[i] - 0.15;
				set(dot, { transform: `scale(${on ? (0.3 + 0.7 * expoOut(prog(l, marks[i] - 0.15, 0.2))).toFixed(3) : 0})` });
				set(line, { transform: `scaleX(${expoOut(prog(l, marks[i] - 0.1, 0.2)).toFixed(3)})` });
				set(pill, { opacity: clamp((l - marks[i]) / 0.06).toFixed(3), transform: `scale(${(0.6 + 0.4 * k).toFixed(4)})` });
			});
		};
	};

	/** Before / after: a divider sweeps across, the cursor dragging it. */
	S_.compare = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, fit, clamp, cubicInOut, prog, alpha, textOn, makeCursor, lerp } = K;
		const s = p.scene;
		const left = el("div", "", cam);
		set(left, { position: "absolute", inset: "0", background: alpha(fg, 0.08), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: px(24 * S) });
		const bl = el("div", "mono", left, s.beforeLabel ?? "Before");
		set(bl, { color: alpha(fg, 0.6), fontSize: px(28 * S) });
		const bt = el("div", "bold", left, s.before);
		set(bt, { color: alpha(fg, 0.55), textDecoration: "line-through", textDecorationThickness: "0.06em", textAlign: "center" });
		fit(bt, W * 0.8, H * 0.3, 120 * S);
		const right = el("div", "", cam);
		set(right, { position: "absolute", inset: "0", background: accent, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: px(24 * S) });
		const al = el("div", "mono", right, s.afterLabel ?? "After");
		set(al, { color: alpha(textOn(accent), 0.7), fontSize: px(28 * S) });
		const at = el("div", "display", right, s.after);
		set(at, { color: textOn(accent), textAlign: "center" });
		fit(at, W * 0.8, H * 0.34, 150 * S);
		const handle = el("div", "", cam);
		set(handle, { position: "absolute", top: "0", bottom: "0", width: px(8 * S), background: "#ffffff", boxShadow: `0 0 ${px(30 * S)} rgba(0,0,0,0.25)` });
		const knob = el("div", "", handle);
		set(knob, { position: "absolute", top: "50%", left: "50%", width: px(84 * S), height: px(84 * S), marginLeft: px(-42 * S), marginTop: px(-42 * S), borderRadius: "50%", background: "#ffffff", boxShadow: `0 ${px(10 * S)} ${px(30 * S)} rgba(0,0,0,0.25)` });
		const cursor = makeCursor(cam, 72 * S);
		const from = p.dur * 0.3;
		const to = p.dur * 0.8;
		return (l) => {
			const k = cubicInOut(prog(l, from, to - from));
			const x = lerp(W * 0.94, -W * 0.02, k);
			set(right, { clipPath: `inset(0 0 0 ${px(Math.max(0, x))})` });
			set(handle, { left: px(x - 4 * S), opacity: x > 0 ? "1" : "0" });
			cursor(l, { fx: x + 200 * S, fy: H / 2 + 200 * S, x: x + 10 * S, y: H / 2 + 10 * S, start: 0.05, arrive: from - 0.08, click: from - 0.02, ringColor: alpha("#ffffff", 0.9) });
			if (l > from) cursor(l, { fx: x + 10 * S, fy: H / 2 + 10 * S, x: x + 10 * S, y: H / 2 + 10 * S, start: from, arrive: from + 0.01, click: 1e9 });
			set(bt, { opacity: clamp(l / 0.15).toFixed(3) });
		};
	};
})();
