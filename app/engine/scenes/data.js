// Data scenes: a rolling-digit stat with a trend line, charts, a timeline, a pricing card and a
// dotted globe. Pure functions of the scene clock.
(() => {
	const S_ = (window.KineticScenes ??= {});
	const SVG = "http://www.w3.org/2000/svg";
	const svgEl = (tag, attrs, parent) => {
		const n = document.createElementNS(SVG, tag);
		for (const k in attrs) n.setAttribute(k, String(attrs[k]));
		if (parent) parent.appendChild(n);
		return n;
	};
	const fmt = (v, decimals = 0) => {
		const fixed = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(decimals);
		return fixed;
	};
	/** 1200000 -> 1.2M style when the number is large, so it stays big on screen. */
	const compact = (v) => {
		const a = Math.abs(v);
		if (a >= 1e9) return { n: v / 1e9, s: "B", d: 1 };
		if (a >= 1e6) return { n: v / 1e6, s: "M", d: 1 };
		if (a >= 1e4) return { n: v / 1e3, s: "K", d: 0 };
		return { n: v, s: "", d: String(v).split(".")[1]?.length ?? 0 };
	};

	S_.stat = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, fitLine, expoOut, prog, clamp, spring, alpha, hash } = K;
		const s = p.scene;
		const c = compact(s.value);
		const vertical = H > W * 1.2;
		const wrap = el("div", "center", cam);
		const label = el("div", "mono", wrap, s.label);
		set(label, { color: fg, opacity: "0.75", fontSize: px(28 * S), marginBottom: px(20 * S) });
		const num = el("div", "display", wrap, `${s.prefix ?? ""}${fmt(c.n, c.d)}${c.s}${s.suffix ?? ""}`);
		set(num, { color: fg, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.05em", whiteSpace: "nowrap" });
		const size = fitLine(num, W * 0.8, H * 0.32, 340 * S);
		const trend = s.trend ?? "up";
		let path = null;
		let area = null;
		let dot = null;
		let len = 0;
		const cw = vertical ? W * 0.84 : W * 0.6;
		const ch = H * 0.22;
		if (trend !== "none") {
			const svg = svgEl("svg", { width: cw, height: ch, viewBox: `0 0 ${cw} ${ch}` }, wrap);
			svg.style.marginTop = px(30 * S);
			svg.style.overflow = "visible";
			const pts = Array.from({ length: 24 }, (_, i) => {
				const x = (i / 23) * cw;
				const base = trend === "up" ? i / 23 : 1 - i / 23;
				const y = ch - (0.08 + 0.84 * (base * 0.85 + hash(i * 1.7) * 0.15)) * ch;
				return [x, y];
			});
			const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
			const defs = svgEl("defs", {}, svg);
			const grad = svgEl("linearGradient", { id: `sg${p.index}`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
			svgEl("stop", { offset: "0%", "stop-color": accent, "stop-opacity": 0.35 }, grad);
			svgEl("stop", { offset: "100%", "stop-color": accent, "stop-opacity": 0 }, grad);
			area = svgEl("path", { d: `${d} L${cw},${ch} L0,${ch} Z`, fill: `url(#sg${p.index})` }, svg);
			path = svgEl("path", { d, fill: "none", stroke: accent, "stroke-width": 6 * S, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
			len = path.getTotalLength();
			path.setAttribute("stroke-dasharray", String(len));
			dot = svgEl("circle", { r: 10 * S, fill: accent }, svg);
		}
		return (l) => {
			const k = expoOut(prog(l, 0.05, Math.min(1.3, p.dur * 0.65)));
			const v = c.n * k;
			num.textContent = `${s.prefix ?? ""}${fmt(v, c.d)}${c.s}${s.suffix ?? ""}`;
			const e = spring(l, 2.6, 0.6);
			set(num, { transform: `translateY(${px((1 - e) * 50 * S)})`, opacity: clamp(l / 0.08).toFixed(3) });
			set(label, { opacity: (0.75 * clamp(l / 0.15)).toFixed(3) });
			if (path) {
				const dk = expoOut(prog(l, 0.15, Math.min(1.2, p.dur * 0.6)));
				path.setAttribute("stroke-dashoffset", String(len * (1 - dk)));
				area.setAttribute("opacity", String(dk));
				const pt = path.getPointAtLength(len * dk);
				dot.setAttribute("cx", String(pt.x));
				dot.setAttribute("cy", String(pt.y));
				dot.setAttribute("r", String(10 * S * (1 + 0.25 * Math.sin(l * 9))));
			}
			void size;
			void alpha;
		};
	};

	S_.chart = ({ p, cam, fg, accent, palette, bg, K }) => {
		const { W, H, S, el, set, px, fit, expoOut, prog, clamp, spring, alpha, lum } = K;
		const s = p.scene;
		const vertical = H > W * 1.2;
		const wrap = el("div", "center", cam);
		if (s.title) {
			const t = el("div", "display", wrap, s.title);
			set(t, { color: fg, marginBottom: px(40 * S) });
			fit(t, W * 0.84, H * 0.14, 110 * S);
		}
		const cw = vertical ? W * 0.86 : W * 0.66;
		const ch = H * (s.title ? 0.56 : 0.66);
		const max = Math.max(...s.values, 1e-9);
		const n = s.values.length;
		const cols = [accent, palette.electric, palette.coral, palette.lime, palette.peach, palette.sage, palette.lilac, palette.butter].filter((c, i, a) => a.indexOf(c) === i);
		const box = el("div", "", wrap);
		set(box, { position: "relative", width: px(cw), height: px(ch) });
		let draw = () => {};
		if (s.kind === "bar") {
			const gap = cw * 0.03;
			const bw = (cw - gap * (n - 1)) / n;
			const bars = s.values.map((v, i) => {
				const b = el("div", "", box);
				set(b, { position: "absolute", left: px(i * (bw + gap)), bottom: px(44 * S), width: px(bw), borderRadius: `${px(bw * 0.12)} ${px(bw * 0.12)} 0 0`, background: s.values[i] === Math.max(...s.values) ? accent : alpha(fg, 0.85), transformOrigin: "50% 100%" });
				const val = el("div", "mono", box, `${v}${s.unit ?? ""}`);
				set(val, { position: "absolute", left: px(i * (bw + gap)), width: px(bw), textAlign: "center", color: fg, fontSize: px(Math.min(30 * S, bw * 0.28)), letterSpacing: "0" });
				const lab = el("div", "mono", box, s.labels?.[i] ?? "");
				set(lab, { position: "absolute", left: px(i * (bw + gap)), width: px(bw), bottom: "0", textAlign: "center", color: alpha(fg, 0.6), fontSize: px(Math.min(24 * S, bw * 0.24)), letterSpacing: "0.04em" });
				return { b, val, h: (v / max) * (ch - 110 * S) };
			});
			const st = Math.min(p.beatLen / 2, (p.dur * 0.5) / n);
			draw = (l) => {
				bars.forEach(({ b, val, h }, i) => {
					const k = spring(l - 0.1 - i * st, 2.6, 0.62);
					set(b, { height: px(Math.max(0, h * k)) });
					set(val, { bottom: px(44 * S + h * k + 8 * S), opacity: clamp((l - 0.2 - i * st) / 0.1).toFixed(3) });
				});
			};
		} else if (s.kind === "line") {
			const svg = svgEl("svg", { width: cw, height: ch, viewBox: `0 0 ${cw} ${ch}` }, box);
			svg.style.overflow = "visible";
			for (let g = 0; g <= 4; g++) svgEl("line", { x1: 0, x2: cw, y1: (g / 4) * (ch - 50 * S), y2: (g / 4) * (ch - 50 * S), stroke: alpha(fg, 0.1), "stroke-width": 1.5 * S }, svg);
			const pts = s.values.map((v, i) => [(i / (n - 1)) * cw, (ch - 50 * S) * (1 - v / max) + 6 * S]);
			const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
			const path = svgEl("path", { d, fill: "none", stroke: accent, "stroke-width": 7 * S, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
			const len = path.getTotalLength();
			path.setAttribute("stroke-dasharray", String(len));
			const dots = pts.map(([x, y]) => svgEl("circle", { cx: x, cy: y, r: 0, fill: accent }, svg));
			const labs = (s.labels ?? []).map((t, i) => {
				const lb = el("div", "mono", box, t);
				set(lb, { position: "absolute", bottom: "0", left: px(pts[i]?.[0] ?? 0), transform: "translateX(-50%)", color: alpha(fg, 0.6), fontSize: px(22 * S) });
				return lb;
			});
			draw = (l) => {
				const k = expoOut(prog(l, 0.1, Math.min(1.4, p.dur * 0.7)));
				path.setAttribute("stroke-dashoffset", String(len * (1 - k)));
				dots.forEach((c, i) => c.setAttribute("r", String(k >= i / (n - 1) - 0.001 ? 9 * S : 0)));
				labs.forEach((lb) => set(lb, { opacity: clamp(l / 0.3).toFixed(3) }));
			};
		} else {
			// Pie / ring: slices sweep in, the biggest one pops out.
			const d = Math.min(cw, ch);
			const total = s.values.reduce((a, b) => a + b, 0) || 1;
			const disc = el("div", "", box);
			set(disc, { position: "absolute", left: px((cw - d) / 2), top: "0", width: px(d), height: px(d), borderRadius: "50%" });
			let hole = null;
			if (s.kind === "ring") {
				hole = el("div", "", box);
				set(hole, { position: "absolute", left: px((cw - d * 0.6) / 2), top: px(d * 0.2), width: px(d * 0.6), height: px(d * 0.6), borderRadius: "50%", background: bg ?? "#fff", display: "flex", alignItems: "center", justifyContent: "center" });
				const pct = el("div", "display", hole, `${Math.round((s.values[0] / total) * 100)}%`);
				set(pct, { color: fg, fontSize: px(d * 0.16) });
			}
			const legend = (s.labels ?? []).slice(0, n).map((t, i) => {
				const lg = el("div", "mono", box, t);
				const ang = ((s.values.slice(0, i).reduce((a, b) => a + b, 0) + s.values[i] / 2) / total) * Math.PI * 2 - Math.PI / 2;
				set(lg, { position: "absolute", left: px(cw / 2 + Math.cos(ang) * d * 0.62), top: px(d / 2 + Math.sin(ang) * d * 0.62), transform: "translate(-50%,-50%)", color: fg, fontSize: px(24 * S), whiteSpace: "nowrap" });
				return lg;
			});
			draw = (l) => {
				const k = expoOut(prog(l, 0.08, Math.min(1.2, p.dur * 0.6)));
				let acc = 0;
				const stops = s.values.map((v, i) => {
					const a0 = (acc / total) * 360 * k;
					acc += v;
					const a1 = (acc / total) * 360 * k;
					return `${cols[i % cols.length]} ${a0.toFixed(2)}deg ${a1.toFixed(2)}deg`;
				});
				set(disc, { background: `conic-gradient(${stops.join(", ")}, ${alpha(fg, 0.08)} ${(360 * k).toFixed(2)}deg 360deg)`, transform: `rotate(${((1 - k) * -90).toFixed(2)}deg) scale(${(0.8 + 0.2 * spring(l, 2.4, 0.7)).toFixed(4)})` });
				legend.forEach((lg, i) => set(lg, { opacity: clamp((l - 0.6 - i * 0.08) / 0.15).toFixed(3) }));
				if (hole) set(hole, { opacity: clamp(l / 0.2).toFixed(3) });
			};
		}
		return (l) => {
			draw(l);
			void lum;
		};
	};

	S_.timeline = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, fit, expoOut, prog, clamp, spring, alpha } = K;
		const s = p.scene;
		const n = s.items.length;
		const marks = p.marks ?? s.items.map((_, i) => 0.3 + i * p.beatLen);
		const wrap = el("div", "center", cam);
		if (s.title) {
			const t = el("div", "display", wrap, s.title);
			set(t, { color: fg, position: "absolute", top: px(H * 0.12) });
			fit(t, W * 0.84, H * 0.14, 120 * S);
		}
		const vertical = H > W * 1.2;
		const len = vertical ? H * 0.6 : W * 0.8;
		const track = el("div", "", cam);
		const x0 = vertical ? W * 0.3 : (W - len) / 2;
		const y0 = vertical ? (H - len) / 2 + H * 0.06 : H * 0.56;
		set(track, { position: "absolute", left: px(x0), top: px(y0), width: px(vertical ? 6 * S : len), height: px(vertical ? len : 6 * S), background: alpha(fg, 0.15), borderRadius: px(3 * S), overflow: "hidden" });
		const fill = el("div", "", track);
		set(fill, { position: "absolute", left: "0", top: "0", background: accent, width: vertical ? "100%" : "0", height: vertical ? "0" : "100%" });
		const nodes = s.items.map((text, i) => {
			const f = n === 1 ? 0.5 : i / (n - 1);
			const cx = vertical ? x0 + 3 * S : x0 + f * len;
			const cy = vertical ? y0 + f * len : y0 + 3 * S;
			const dot = el("div", "", cam);
			set(dot, { position: "absolute", left: px(cx - 18 * S), top: px(cy - 18 * S), width: px(36 * S), height: px(36 * S), borderRadius: "50%", boxSizing: "border-box", border: `${px(6 * S)} solid ${accent}` });
			const lab = el("div", "bold", cam, text);
			const above = !vertical && i % 2 === 0;
			set(lab, { position: "absolute", color: fg, fontSize: px((vertical ? 54 : 50) * S), whiteSpace: "nowrap", ...(vertical ? { left: px(cx + 50 * S), top: px(cy - 32 * S) } : { left: px(cx), top: px(above ? cy - 110 * S : cy + 50 * S) }) });
			// Centre the label on its dot, but never past the frame's edge (first and last items).
			const w = lab.offsetWidth;
			const margin = W * 0.04;
			const ox = vertical ? 0 : Math.min(W - margin - cx - w, Math.max(margin - cx, -w / 2));
			return { dot, lab, f, above, ox };
		});
		return (l) => {
			let v = 0;
			for (let i = 0; i < n; i++) v = Math.max(v, nodes[i].f * expoOut(prog(l, marks[i] - 0.25, 0.3)));
			set(fill, vertical ? { height: `${(v * 100).toFixed(2)}%` } : { width: `${(v * 100).toFixed(2)}%` });
			nodes.forEach(({ dot, lab, above, ox }, i) => {
				const k = spring(l - marks[i], 3, 0.55);
				const on = l >= marks[i];
				set(dot, { background: on ? accent : "transparent", transform: `scale(${(0.4 + 0.6 * k).toFixed(4)})`, opacity: clamp((l - marks[i] + 0.1) / 0.1).toFixed(3) });
				const t = vertical ? `translateX(${px((1 - k) * 40 * S)})` : `translateX(${px(ox)}) translateY(${px((1 - k) * (above ? 30 : -30) * S)})`;
				set(lab, { opacity: clamp((l - marks[i]) / 0.1).toFixed(3), transform: t });
			});
		};
	};

	S_.pricing = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, expoOut, prog, clamp, spring, alpha, textOn, makeCursor } = K;
		const s = p.scene;
		const vertical = H > W * 1.2;
		const cw = vertical ? W * 0.82 : Math.min(W * 0.36, 720 * S);
		const card = el("div", "card", cam);
		const cardBg = textOn(fg) === "#111111" ? "#ffffff" : "#111111";
		const ink = textOn(cardBg);
		set(card, { width: px(cw), left: px((W - cw) / 2), background: cardBg, color: ink, borderRadius: px(36 * S), padding: px(56 * S), boxShadow: `0 ${px(50 * S)} ${px(110 * S)} rgba(0,0,0,0.25)`, display: "flex", flexDirection: "column", gap: px(22 * S) });
		const name = el("div", "mono", card, s.name);
		set(name, { fontSize: px(28 * S), opacity: "0.7" });
		const priceRow = el("div", "", card);
		set(priceRow, { display: "flex", alignItems: "baseline", gap: px(10 * S) });
		const price = el("div", "display", priceRow, `$${s.price}`);
		set(price, { fontSize: px(150 * S), color: ink, fontVariantNumeric: "tabular-nums" });
		const per = el("div", "bold", priceRow, s.period ?? "");
		set(per, { fontSize: px(40 * S), opacity: "0.6" });
		const feats = s.features.map((f) => {
			const r = el("div", "", card);
			set(r, { display: "flex", alignItems: "center", gap: px(18 * S), fontSize: px(38 * S), fontWeight: "560", letterSpacing: "-0.015em" });
			const ck = el("div", "", r);
			set(ck, { width: px(40 * S), height: px(40 * S), borderRadius: "50%", background: accent, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" });
			ck.innerHTML = `<svg viewBox="0 0 24 24" width="62%" height="62%"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="${textOn(accent)}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
			el("div", "", r, f);
			return r;
		});
		const btn = el("div", "", card, s.cta ?? "Get started");
		set(btn, { marginTop: px(16 * S), height: px(96 * S), borderRadius: px(48 * S), background: accent, color: textOn(accent), display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "700", fontSize: px(38 * S) });
		const cursor = makeCursor(cam, 80 * S);
		const chH = card.offsetHeight;
		const top = (H - chH) / 2;
		const clickAt = p.dur * 0.78;
		return (l) => {
			const e = spring(l, 2.4, 0.65);
			set(card, { top: px(top), transform: `translateY(${px((1 - e) * H * 0.5)}) rotate(${((1 - e) * -6).toFixed(2)}deg)`, opacity: clamp(l / 0.1).toFixed(3) });
			const pk = expoOut(prog(l, 0.15, 0.9));
			price.textContent = `$${Math.round(s.price * pk)}`;
			feats.forEach((r, i) => {
				const k = spring(l - 0.45 - i * 0.12, 3, 0.6);
				set(r, { opacity: clamp((l - 0.45 - i * 0.12) / 0.08).toFixed(3), transform: `translateX(${px((1 - k) * 40 * S)})` });
			});
			const press = l >= clickAt && l < clickAt + 0.14;
			set(btn, { transform: `scale(${press ? 0.95 : 1})`, filter: press ? "brightness(0.92)" : "none" });
			const bx = W / 2;
			const by = top + chH - 56 * S - 48 * S;
			cursor(l, { fx: bx + 300 * S, fy: by + 260 * S, x: bx + 60 * S, y: by, start: clickAt - 0.55, arrive: clickAt - 0.05, click: clickAt, ringColor: alpha(accent, 0.9) });
		};
	};

	/** A dotted globe turning, with arcs drawing between points. */
	S_.globe = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, fit, expoOut, prog, clamp, spring, alpha, hash } = K;
		const s = p.scene;
		const r = Math.min(W, H) * 0.34;
		const cx = W / 2;
		const cy = H / 2 + (s.label ? H * 0.06 : 0);
		const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
		cam.appendChild(svg);
		set(svg, { position: "absolute", left: "0", top: "0" });
		svgEl("circle", { cx, cy, r, fill: alpha(fg, 0.04), stroke: alpha(fg, 0.18), "stroke-width": 2 * S }, svg);
		const N = 420;
		const pts = [];
		const golden = Math.PI * (3 - Math.sqrt(5));
		for (let i = 0; i < N; i++) {
			const y = 1 - (i / (N - 1)) * 2;
			const rad = Math.sqrt(1 - y * y);
			const th = golden * i;
			// Keep roughly 60% as "land" so it reads as a world, not a ball.
			if (hash(i * 1.3) < 0.4) continue;
			pts.push({ x: Math.cos(th) * rad, y, z: Math.sin(th) * rad, c: svgEl("circle", { r: 3.2 * S, fill: fg }, svg) });
		}
		const arcs = Array.from({ length: 6 }, (_, i) => {
			const a = pts[Math.floor(hash(i * 7.1) * pts.length)];
			const b = pts[Math.floor(hash(i * 3.3 + 2) * pts.length)];
			const path = svgEl("path", { fill: "none", stroke: accent, "stroke-width": 4 * S, "stroke-linecap": "round" }, svg);
			return { a, b, path, at: 0.4 + i * 0.18 };
		});
		let label = null;
		if (s.label) {
			label = el("div", "display", cam, s.label);
			set(label, { position: "absolute", left: "0", right: "0", top: px(H * 0.06), textAlign: "center", color: fg, margin: "0 auto" });
			fit(label, W * 0.84, H * 0.12, 110 * S);
		}
		const project = (q, rot) => {
			const x = q.x * Math.cos(rot) - q.z * Math.sin(rot);
			const z = q.x * Math.sin(rot) + q.z * Math.cos(rot);
			const tilt = 0.35;
			const y = q.y * Math.cos(tilt) - z * Math.sin(tilt);
			const z2 = q.y * Math.sin(tilt) + z * Math.cos(tilt);
			return { x: cx + x * r, y: cy - y * r, z: z2 };
		};
		return (l) => {
			const rot = l * 0.6;
			const e = spring(l, 2.2, 0.7);
			set(svg, { transform: `scale(${(0.7 + 0.3 * e).toFixed(4)})`, transformOrigin: `${cx}px ${cy}px`, opacity: clamp(l / 0.15).toFixed(3) });
			for (const q of pts) {
				const pr = project(q, rot);
				q.c.setAttribute("cx", pr.x.toFixed(1));
				q.c.setAttribute("cy", pr.y.toFixed(1));
				q.c.setAttribute("opacity", pr.z > 0 ? "0.9" : "0.15");
			}
			for (const a of arcs) {
				const p1 = project(a.a, rot);
				const p2 = project(a.b, rot);
				const mx = (p1.x + p2.x) / 2;
				const my = (p1.y + p2.y) / 2 - r * 0.45;
				a.path.setAttribute("d", `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`);
				const len = a.path.getTotalLength() || 1;
				const k = expoOut(prog(l, a.at, 0.7));
				a.path.setAttribute("stroke-dasharray", `${len}`);
				a.path.setAttribute("stroke-dashoffset", `${len * (1 - k)}`);
				a.path.setAttribute("opacity", p1.z > -0.2 && p2.z > -0.2 ? "1" : "0.25");
			}
			if (label) set(label, { opacity: clamp(l / 0.2).toFixed(3), transform: `translateY(${px((1 - e) * 30 * S)})` });
		};
	};
})();
