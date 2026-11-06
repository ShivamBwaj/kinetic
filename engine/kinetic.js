// Kinetic film engine. Plays a plan (see shared/timeline.ts): every frame is a pure function of
// time, so preview and export show exactly the same picture and any frame renders on its own.
// Host API: window.setupFilm(plan, opts) -> Promise, window.renderFrame(t) -> Promise.
// Preview hosts can drive it with postMessage instead (load / play / pause / seek).
(() => {
	// ---------- maths ----------
	const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
	const lerp = (a, b, t) => a + (b - a) * t;
	const prog = (t, at, d) => (d <= 0 ? (t >= at ? 1 : 0) : clamp((t - at) / d));
	const expoOut = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
	const expoIn = (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10));
	const expoInOut = (t) =>
		t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
	const cubicInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
	const quartOut = (t) => 1 - (1 - clamp(t)) ** 4;
	/** Film-wide motion tuning from the plan (snap, bounce, transition curve). Neutral by default. */
	let M = { snap: 1, bounce: 1, curve: null, camera: "push" };
	/** CSS-style cubic-bezier(x1, y1, x2, y2) as a function of progress 0..1 (Newton, then bisection). */
	const bezier = ([x1, y1, x2, y2]) => {
		const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
		const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
		const X = (u) => ((ax * u + bx) * u + cx) * u;
		const Y = (u) => ((ay * u + by) * u + cy) * u;
		const dX = (u) => (3 * ax * u + 2 * bx) * u + cx;
		return (x) => {
			if (x <= 0) return 0;
			if (x >= 1) return 1;
			let u = x;
			for (let i = 0; i < 8; i++) {
				const d = dX(u);
				if (Math.abs(d) < 1e-6) break;
				const nu = u - (X(u) - x) / d;
				if (nu < 0 || nu > 1) break;
				u = nu;
			}
			if (Math.abs(X(u) - x) > 1e-4) {
				let lo = 0, hi = 1;
				for (let i = 0; i < 30; i++) {
					u = (lo + hi) / 2;
					if (X(u) < x) lo = u;
					else hi = u;
				}
			}
			return Y(u);
		};
	};
	/** Underdamped spring step response, 0 -> 1 with overshoot. Closed form: no state.
	 *  Snap scales its speed; bounce scales its overshoot (0 = critically damped, no overshoot). */
	const spring = (t, freq = 3.6, damp = 0.5) => {
		if (t <= 0) return 0;
		freq *= M.snap;
		damp = M.bounce <= 0.01 ? 0.999 : Math.min(0.999, Math.max(0.12, damp / M.bounce));
		const w = 2 * Math.PI * freq;
		const wd = w * Math.sqrt(1 - damp * damp);
		return 1 - Math.exp(-damp * w * t) * (Math.cos(wd * t) + ((damp * w) / wd) * Math.sin(wd * t));
	};
	const hash = (n) => {
		const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
		return x - Math.floor(x);
	};
	const lum = (hex) => {
		const h = String(hex).replace("#", "");
		const f = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
		const [r, g, b] = [0, 2, 4].map((i) => {
			const c = Number.parseInt(f.slice(i, i + 2), 16) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const textOn = (bg) => (bg === "sky" ? "#ffffff" : lum(bg) > 0.33 ? "#111111" : "#ffffff");
	const alpha = (hex, a) => {
		const h = String(hex).replace("#", "");
		const f = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
		const n = Number.parseInt(f, 16);
		return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
	};

	// ---------- dom ----------
	const el = (tag, cls, parent, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		if (parent) parent.appendChild(n);
		return n;
	};
	const set = (n, styles) => {
		for (const k in styles) {
			const v = styles[k];
			if (n.__s?.[k] === v) continue;
			(n.__s ??= {})[k] = v;
			n.style[k] = v;
		}
	};
	const px = (v) => `${v.toFixed(2)}px`;

	/** Largest font size (px) at which node fits maxW x maxH, wrapping allowed. */
	const fit = (node, maxW, maxH, hi = 600, lo = 12) => {
		const ts = plan?.look?.typeScale ?? 1;
		if (ts !== 1 && !node.closest?.(".mock")) {
			maxW *= Math.min(1, ts + 0.15);
			maxH *= ts;
			hi *= ts;
		}
		node.style.maxWidth = px(maxW);
		let a = lo;
		let b = hi;
		for (let i = 0; i < 14; i++) {
			const m = (a + b) / 2;
			node.style.fontSize = px(m);
			const ok = node.scrollWidth <= maxW + 1 && node.offsetHeight <= maxH;
			if (ok) a = m;
			else b = m;
		}
		node.style.fontSize = px(a);
		return a;
	};
	/** Single-line fit by width (and height). */
	const fitLine = (node, maxW, maxH, hi = 900) => {
		const ts = plan?.look?.typeScale ?? 1;
		maxW *= ts;
		maxH *= ts;
		node.style.whiteSpace = "nowrap";
		node.style.fontSize = "100px";
		const w = node.scrollWidth || 1;
		const h = node.offsetHeight || 1;
		const size = Math.min(hi, (100 * maxW) / w, (100 * maxH) / h);
		node.style.fontSize = px(size);
		return size;
	};

	/** "The *fastest* way" -> word spans of glyph spans; *word* marks the accent. */
	const glyphText = (parent, text, { glyphs: split = true } = {}) => {
		const glyphs = [];
		const words = [];
		let accent = false;
		for (const raw of String(text).split(/(\*)/)) {
			if (raw === "*") {
				accent = !accent;
				continue;
			}
			for (const part of raw.split(/(\s+)/)) {
				if (!part) continue;
				if (/^\s+$/.test(part)) {
					parent.appendChild(document.createTextNode(" "));
					continue;
				}
				const w = el("span", "word", parent);
				if (split && TEXT_MODE() === "mask") {
					// Letters rise through the word's bottom edge (a mask line).
					w.style.overflow = "hidden";
					w.style.verticalAlign = "top";
					w.style.paddingBottom = "0.14em";
					w.style.marginBottom = "-0.14em";
				}
				const rec = { node: w, accent, glyphs: [], index: words.length, text: part };
				words.push(rec);
				if (split)
					for (const ch of part) {
						const g = { node: el("span", "glyph", w, ch), word: rec.index, i: glyphs.length, ch };
						glyphs.push(g);
						rec.glyphs.push(g);
					}
				else w.textContent = part;
			}
		}
		return { glyphs, words };
	};
	const plain = (text) => String(text).replace(/\*/g, "");

	const CURSOR_SVG =
		'<svg viewBox="0 0 28 38" width="100%" height="100%"><path d="M3 2.5 L3 30.5 L10 24 L15 35 L20 32.8 L15.2 22.2 L25 22.2 Z" fill="#fff" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/></svg>';
	const ARROW_UP =
		'<svg viewBox="0 0 24 24" width="52%" height="52%"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
	const PLUS =
		'<svg viewBox="0 0 24 24" width="50%" height="50%"><path d="M12 5v14M5 12h14" fill="none" stroke="#50525c" stroke-width="2.2" stroke-linecap="round"/></svg>';

	// ---------- state ----------
	let plan = null;
	const TEXT_MODE = () => plan?.look?.text ?? "spring";
	let W = 1920;
	let H = 1080;
	let S = 1;
	let built = [];
	let images = {};
	let grain = null;
	let wipebar = null;
	let opts = {};
	const stage = document.getElementById("stage");
	const filters = document.getElementById("filters");

	const loadImage = (src) =>
		new Promise((resolve) => {
			if (!src) return resolve(null);
			const img = new Image();
			img.onload = () => resolve({ src, w: img.naturalWidth, h: img.naturalHeight });
			img.onerror = () => resolve(null);
			img.src = src;
		});

	const noiseTile = () => {
		const c = document.createElement("canvas");
		c.width = c.height = 220;
		const g = c.getContext("2d");
		const d = g.createImageData(220, 220);
		for (let i = 0; i < d.data.length; i += 4) {
			const v = Math.floor(hash(i * 0.37 + 11) * 255);
			d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
			d.data[i + 3] = 255;
		}
		g.putImageData(d, 0, 0);
		return c.toDataURL();
	};

	/** Scene background: flat colour or the painted sky. */
	const paintBg = (root, bg, index) => {
		if (bg !== "sky") {
			root.style.background = bg;
			return () => {};
		}
		const sky = el("div", "sky", root);
		const clouds = [0, 1, 2, 3, 4].map((i) => {
			const c = el("div", "cloud", sky);
			const w = (0.35 + hash(i + index * 7) * 0.4) * W;
			set(c, { width: px(w), height: px(w * 0.32), top: px((0.55 + hash(i * 3.1) * 0.5) * H - w * 0.16) });
			return { c, x: hash(i * 9.7) * 1.2 - 0.3, w, sp: 0.01 + hash(i * 1.3) * 0.02 };
		});
		return (l) => {
			for (const k of clouds) set(k.c, { left: px((k.x + l * k.sp) * W - k.w / 2) });
		};
	};

	// ---------- FX layers (particles, floor, shapes, axes) ----------
	// Every one is a pure function of time from fixed seeds, so preview, scrubbing and export agree.

	/** A canvas over the scene background, drawn in stage units at reduced resolution. */
	const canvasLayer = (root, z) => {
		const R = 0.75;
		const c = el("canvas", "deco", root);
		c.width = Math.round(W * R);
		c.height = Math.round(H * R);
		set(c, { width: px(W), height: px(H), ...(z ? { zIndex: String(z) } : {}) });
		const g = c.getContext("2d");
		return { c, g, clear: () => (g.setTransform(R, 0, 0, R, 0, 0), g.clearRect(0, 0, W, H)) };
	};
	const frac = (x) => x - Math.floor(x);
	const beatKick = (t, k = 8) => Math.exp(-((t + 1e-6) % plan.beat) * k);

	/** Particle field: stars warping toward the lens, embers rising, dust motes, a confetti burst,
	 *  soft bokeh, or chrome glints. Brightens on every beat. */
	const particleField = (root, ps, kind, bgHex, burst) => {
		const { g, clear } = canvasLayer(root);
		const pal = plan.palette;
		const dark = lum(bgHex) < 0.3;
		const N = { stars: 150, embers: 70, dust: 90, confetti: 110, bokeh: 20, sparks: 46 }[kind] ?? 60;
		const cols = {
			stars: ["#ffffff", "#ffffff", pal.lime, pal.coral, pal.lilac],
			embers: [pal.peach, pal.butter, pal.coral, pal.lime],
			dust: [dark ? "#ffffff" : pal.ink],
			confetti: [pal.coral, pal.electric, pal.butter, pal.lime, pal.lilac, pal.peach].filter((c) => c && c !== bgHex),
			bokeh: [pal.coral, pal.electric, pal.lilac, pal.butter, "#ffffff"],
			sparks: ["#ffffff", pal.lime, pal.electric],
		}[kind];
		const P = Array.from({ length: N }, (_, i) => {
			const h = (k) => hash(i * 17.31 + k * 3.77 + ps.index * 101.3);
			return { a: h(1), b: h(2), c: h(3), d: h(4), e: h(5), col: cols[Math.floor(h(6) * cols.length)] ?? "#fff", i };
		});
		return (l) => {
			const t = ps.start + l;
			const kick = beatKick(t);
			clear();
			if (kind === "stars") {
				const R = Math.hypot(W, H) * 0.6;
				for (const p of P) {
					const z = frac(p.b + l * 0.09 * (0.6 + p.c));
					const ang = p.a * Math.PI * 2;
					const r = z * z * R + 6 * S;
					const x = W / 2 + Math.cos(ang) * r;
					const y = H / 2 + Math.sin(ang) * r * 0.8;
					const tw = 0.6 + 0.4 * Math.sin(t * (2 + p.d * 5) + p.e * 9);
					const s = (0.6 + 2.6 * z) * S * (1 + kick * 0.6);
					g.globalAlpha = clamp(z * 2.2) * tw * (0.55 + 0.45 * kick);
					g.fillStyle = p.col;
					g.beginPath();
					g.arc(x, y, s, 0, Math.PI * 2);
					g.fill();
					if (z > 0.55) {
						// Streaks toward the edges as they rush past.
						const len = (z - 0.55) * 60 * S * (1 + kick * 2);
						g.strokeStyle = p.col;
						g.lineWidth = s * 0.9;
						g.beginPath();
						g.moveTo(x, y);
						g.lineTo(x - Math.cos(ang) * len, y - Math.sin(ang) * len * 0.8);
						g.stroke();
					}
				}
			} else if (kind === "embers") {
				for (const p of P) {
					const u = frac(p.b + l * (0.06 + 0.08 * p.c));
					const x = p.a * W + Math.sin(l * (0.8 + p.d) + p.e * 6) * 50 * S;
					const y = H * (1.08 - u * 1.25);
					const s = (1.5 + p.c * 3.5) * S;
					const fade = Math.sin(u * Math.PI);
					g.fillStyle = p.col;
					g.globalAlpha = fade * 0.18 * (1 + kick);
					g.beginPath();
					g.arc(x, y, s * 4, 0, Math.PI * 2);
					g.fill();
					g.globalAlpha = fade * 0.9;
					g.beginPath();
					g.arc(x, y, s, 0, Math.PI * 2);
					g.fill();
				}
			} else if (kind === "dust") {
				g.fillStyle = cols[0];
				for (const p of P) {
					const x = frac(p.a + l * 0.012 * (p.c - 0.5)) * W;
					const y = frac(p.b - l * 0.01 * (0.3 + p.d)) * H;
					g.globalAlpha = (0.12 + 0.35 * p.e) * (0.6 + 0.4 * Math.sin(t * (1 + p.c * 3) + p.d * 7));
					g.beginPath();
					g.arc(x, y, (0.8 + p.c * 2.2) * S, 0, Math.PI * 2);
					g.fill();
				}
			} else if (kind === "confetti") {
				// Two party cannons fire from the bottom corners (drag + gravity, closed form), then a
				// light drift keeps falling.
				const kD = 1.7;
				const grav = 1.6 * H;
				const vt = grav / kD;
				for (const p of P) {
					let x, y, rot, flip;
					if (burst && p.i < N * 0.7) {
						const dt = l - p.c * 0.18;
						if (dt < 0) continue;
						const side = p.i % 2 ? 1 : -1;
						const vx = -side * (0.25 + 0.55 * p.a) * W;
						const vy = -(1.1 + 0.9 * p.b) * H;
						const e = (1 - Math.exp(-kD * dt)) / kD;
						x = (side > 0 ? W * 1.02 : -W * 0.02) + vx * e;
						y = H * 1.02 + (vy - vt) * e + vt * dt;
						rot = p.d * 6 + dt * (3 + p.e * 8);
						flip = Math.cos(dt * (5 + p.c * 7) + p.a * 6);
					} else {
						const u = frac(p.b + l * (0.07 + 0.06 * p.c));
						x = p.a * W + Math.sin(l * 1.3 + p.d * 6) * 40 * S;
						y = -0.05 * H + u * 1.1 * H;
						rot = p.d * 6 + l * (1 + p.e * 2);
						flip = Math.cos(l * (3 + p.c * 4) + p.a * 6);
						g.globalAlpha = burst ? 0 : 0.85;
						if (burst) continue;
					}
					if (y > H + 40 * S) continue;
					g.globalAlpha = 0.95;
					g.fillStyle = p.col;
					g.save();
					g.translate(x, y);
					g.rotate(rot);
					g.scale(1, flip);
					if (p.e > 0.7) {
						g.beginPath();
						g.arc(0, 0, 6 * S, 0, Math.PI * 2);
						g.fill();
					} else g.fillRect(-9 * S, -5 * S, 18 * S, 10 * S);
					g.restore();
				}
			} else if (kind === "bokeh") {
				g.globalCompositeOperation = dark ? "screen" : "source-over";
				for (const p of P) {
					const r = (50 + p.c * 150) * S;
					const x = (p.a * 1.2 - 0.1) * W + Math.sin(l * 0.25 + p.d * 6) * 80 * S;
					const y = (p.b * 1.2 - 0.1) * H + Math.cos(l * 0.2 + p.e * 6) * 60 * S;
					const gr = g.createRadialGradient(x, y, 0, x, y, r);
					gr.addColorStop(0, alpha(p.col, 0.42));
					gr.addColorStop(0.7, alpha(p.col, 0.22));
					gr.addColorStop(1, alpha(p.col, 0));
					g.globalAlpha = (0.55 + 0.45 * Math.sin(t * 0.8 + p.d * 9)) * (dark ? 0.8 : 0.65);
					g.fillStyle = gr;
					g.beginPath();
					g.arc(x, y, r, 0, Math.PI * 2);
					g.fill();
				}
				g.globalCompositeOperation = "source-over";
			} else if (kind === "sparks") {
				g.globalCompositeOperation = "lighter";
				for (const p of P) {
					const x = (p.a + l * 0.006 * (p.c - 0.5)) * W;
					const y = (p.b + l * 0.004 * (p.d - 0.5)) * H;
					const glint = Math.max(0, Math.sin(t * (0.9 + p.c * 1.6) + p.e * 12)) ** 8 + kick * 0.35 * (p.d > 0.6 ? 1 : 0);
					if (glint < 0.02) continue;
					const s = (10 + p.c * 26) * S * glint;
					g.globalAlpha = clamp(glint);
					g.strokeStyle = p.col;
					g.lineWidth = 1.6 * S;
					g.beginPath();
					g.moveTo(x - s, y);
					g.lineTo(x + s, y);
					g.moveTo(x, y - s);
					g.lineTo(x, y + s);
					g.stroke();
					g.fillStyle = "#ffffff";
					g.beginPath();
					g.arc(x, y, 2.2 * S * glint, 0, Math.PI * 2);
					g.fill();
				}
				g.globalCompositeOperation = "source-over";
			}
			g.globalAlpha = 1;
		};
	};

	/** Synthwave floor: a perspective grid rolling toward the camera, pulsing on the beat. */
	const gridFloor = (root, ps) => {
		const pal = plan.palette;
		const hz = H * (H > W ? 0.66 : 0.6);
		// Horizon glow above, a dark ground below; the grid draws over it.
		const sky = el("div", "deco", root);
		set(sky, { background: `linear-gradient(180deg, transparent ${((hz / H) * 100 - 22).toFixed(1)}%, ${alpha(pal.electric, 0.3)} ${((hz / H) * 100 - 3).toFixed(1)}%, ${alpha(pal.coral, 0.55)} ${((hz / H) * 100).toFixed(1)}%, ${alpha(pal.ink, 0.9)} ${((hz / H) * 100 + 0.4).toFixed(1)}%, ${alpha(pal.ink, 0.6)} 100%)` });
		const { g, clear } = canvasLayer(root);
		return (l) => {
			const t = ps.start + l;
			const kick = beatKick(t, 6);
			clear();
			const lines = (pass) => {
				g.lineWidth = (pass ? 2 : 9) * S;
				g.globalAlpha = pass ? 0.9 : 0.16 + 0.12 * kick;
				// Horizontals: depth 1 at the bottom edge, converging on the horizon.
				g.strokeStyle = pal.coral;
				const scroll = frac(t * 0.9);
				for (let j = 0; j < 22; j++) {
					const z = 1 + j - scroll;
					if (z <= 0.2) continue;
					const y = hz + (H - hz) * (0.8 / z);
					g.globalAlpha = (pass ? 0.9 : 0.2) * clamp(1.2 - z / 16);
					g.beginPath();
					g.moveTo(0, y);
					g.lineTo(W, y);
					g.stroke();
				}
				// Verticals fanning out from the vanishing point.
				g.strokeStyle = pal.lime;
				g.globalAlpha = pass ? 0.75 : 0.18;
				const sp = W * 0.11;
				for (let k = -14; k <= 14; k++) {
					g.beginPath();
					g.moveTo(W / 2 + k * sp * 0.04, hz);
					g.lineTo(W / 2 + k * sp * 1.9, H);
					g.stroke();
				}
			};
			lines(0);
			lines(1);
			g.globalAlpha = 1;
		};
	};

	/** Maths-explainer axes: a faint grid and two axes drawing themselves on, then a curve. */
	const axesPlane = (root, ps, bgHex) => {
		const pal = plan.palette;
		const ink = lum(bgHex) < 0.35 ? "#ffffff" : pal.ink;
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("class", "deco");
		svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
		svg.setAttribute("width", String(W));
		svg.setAttribute("height", String(H));
		root.appendChild(svg);
		const ox = W * (ps.index % 2 ? 0.86 : 0.12);
		const oy = H * 0.84;
		const cell = 80 * S;
		const path = (d, stroke, w, op) => {
			const p = document.createElementNS(ns, "path");
			p.setAttribute("d", d);
			p.setAttribute("fill", "none");
			p.setAttribute("stroke", stroke);
			p.setAttribute("stroke-width", String(w));
			p.setAttribute("stroke-linecap", "round");
			p.setAttribute("opacity", String(op));
			svg.appendChild(p);
			const len = p.getTotalLength?.() || W * 2;
			p.setAttribute("stroke-dasharray", String(len));
			p.setAttribute("stroke-dashoffset", String(len));
			return { p, len };
		};
		let grid = "";
		for (let x = ox % cell; x < W; x += cell) grid += `M${x.toFixed(1)} 0V${H}`;
		for (let y = oy % cell; y < H; y += cell) grid += `M0 ${y.toFixed(1)}H${W}`;
		const gridP = document.createElementNS(ns, "path");
		gridP.setAttribute("d", grid);
		gridP.setAttribute("stroke", pal.electric);
		gridP.setAttribute("stroke-width", String(1.2 * S));
		gridP.setAttribute("opacity", "0");
		svg.appendChild(gridP);
		const dir = ps.index % 2 ? -1 : 1;
		const xAxis = path(`M${ox - dir * cell} ${oy}H${dir > 0 ? W - cell * 0.5 : cell * 0.5}`, ink, 3 * S, 0.55);
		const yAxis = path(`M${ox} ${oy + cell}V${cell * 0.8}`, ink, 3 * S, 0.55);
		let ticks = "";
		for (let k = 1; k * cell < W; k++) ticks += `M${ox + dir * k * cell} ${oy - 8 * S}v${16 * S}`;
		for (let k = 1; oy - k * cell > cell; k++) ticks += `M${ox - 8 * S} ${oy - k * cell}h${16 * S}`;
		const tickP = path(ticks, ink, 2 * S, 0.4);
		// A logistic curve climbing from the origin, the shape of growth.
		let curve = "";
		const span = (dir > 0 ? W - ox : ox) - cell;
		for (let i = 0; i <= 60; i++) {
			const u = i / 60;
			const y = oy - (oy - cell * 1.6) / (1 + Math.exp(-(u - 0.55) * 9));
			curve += `${i ? "L" : "M"}${(ox + dir * u * span).toFixed(1)} ${y.toFixed(1)}`;
		}
		const curveP = path(curve, pal.butter, 5 * S, 0.5);
		return (l) => {
			const a = cubicInOut(clamp(l / 0.9));
			gridP.setAttribute("opacity", (0.16 * clamp(l / 0.6)).toFixed(3));
			xAxis.p.setAttribute("stroke-dashoffset", (xAxis.len * (1 - a)).toFixed(1));
			yAxis.p.setAttribute("stroke-dashoffset", (yAxis.len * (1 - a)).toFixed(1));
			tickP.p.setAttribute("stroke-dashoffset", (tickP.len * (1 - cubicInOut(clamp((l - 0.4) / 0.8)))).toFixed(1));
			curveP.p.setAttribute("stroke-dashoffset", (curveP.len * (1 - cubicInOut(clamp((l - 0.7) / 2.2)))).toFixed(1));
		};
	};

	/** Playful vector shapes popping in around the frame edges with springs, then floating. */
	const SHAPE_SPOTS = [[0.08, 0.16], [0.9, 0.13], [0.12, 0.84], [0.88, 0.82], [0.5, 0.07], [0.04, 0.5], [0.96, 0.48], [0.62, 0.93], [0.3, 0.06], [0.35, 0.94]];
	const popShapes = (root, ps, bgHex) => {
		const pal = plan.palette;
		const cols = [pal.coral, pal.electric, pal.butter, pal.lime, pal.lilac, pal.peach, pal.ink].filter((c) => c && contrastHex(c, bgHex) > 1.35);
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("class", "deco");
		svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
		svg.setAttribute("width", String(W));
		svg.setAttribute("height", String(H));
		svg.style.overflow = "visible";
		root.appendChild(svg);
		const kinds = ["ring", "squiggle", "star", "pill", "dot", "plus", "tri", "half"];
		const spots = SHAPE_SPOTS.map((s, i) => ({ s, k: hash(i * 3.3 + ps.index * 7.9) })).sort((a, b) => a.k - b.k).slice(0, 6);
		const shapes = spots.map(({ s }, i) => {
			const kind = kinds[Math.floor(hash(i * 5.1 + ps.index * 2.3) * kinds.length)];
			const col = cols[(i + ps.index) % Math.max(1, cols.length)] ?? pal.ink;
			const r = (44 + hash(i * 9.7 + ps.index) * 46) * S;
			const gEl = document.createElementNS(ns, "g");
			svg.appendChild(gEl);
			const add = (tag, attrs) => {
				const n = document.createElementNS(ns, tag);
				for (const k in attrs) n.setAttribute(k, String(attrs[k]));
				gEl.appendChild(n);
				return n;
			};
			let dash = null;
			if (kind === "ring") add("circle", { r: r * 0.8, fill: "none", stroke: col, "stroke-width": r * 0.28 });
			else if (kind === "dot") add("circle", { r: r * 0.7, fill: col });
			else if (kind === "pill") add("rect", { x: -r * 1.1, y: -r * 0.42, width: r * 2.2, height: r * 0.84, rx: r * 0.42, fill: col });
			else if (kind === "plus") add("path", { d: `M${-r} 0H${r}M0 ${-r}V${r}`, stroke: col, "stroke-width": r * 0.38, "stroke-linecap": "round" });
			else if (kind === "tri") add("path", { d: `M0 ${-r}L${r * 0.95} ${r * 0.7}L${-r * 0.95} ${r * 0.7}Z`, fill: col, "stroke-linejoin": "round", stroke: col, "stroke-width": r * 0.2 });
			else if (kind === "half") add("path", { d: `M${-r} ${r * 0.3}A${r} ${r} 0 0 1 ${r} ${r * 0.3}Z`, fill: col });
			else if (kind === "star") {
				const pts = Array.from({ length: 10 }, (_, k) => {
					const a = (k * Math.PI) / 5 - Math.PI / 2;
					const rr = k % 2 ? r * 0.45 : r;
					return `${(Math.cos(a) * rr).toFixed(1)} ${(Math.sin(a) * rr).toFixed(1)}`;
				});
				add("path", { d: `M${pts.join("L")}Z`, fill: col, stroke: col, "stroke-width": r * 0.12, "stroke-linejoin": "round" });
			} else {
				let d = `M${-r * 1.4} 0`;
				for (let k = 0; k < 4; k++) d += `q${r * 0.35} ${k % 2 ? r * 0.7 : -r * 0.7} ${r * 0.7} 0`;
				dash = add("path", { d, fill: "none", stroke: col, "stroke-width": r * 0.26, "stroke-linecap": "round" });
				const len = dash.getTotalLength?.() || r * 6;
				dash.setAttribute("stroke-dasharray", String(len));
				dash.__len = len;
			}
			return { gEl, x: s[0] * W, y: s[1] * H, at: 0.1 + i * 0.08, rot0: (hash(i * 1.9 + ps.index) - 0.5) * 60, spin: (hash(i * 6.1) - 0.5) * 40, dash, ph: hash(i * 2.9) * 6 };
		});
		return (l) => {
			for (const k of shapes) {
				const sc = Math.max(0, spring(l - k.at, 2.4, 0.38));
				const fy = Math.sin(l * 1.6 + k.ph) * 10 * S;
				k.gEl.setAttribute("transform", `translate(${(k.x).toFixed(1)} ${(k.y + fy).toFixed(1)}) rotate(${(k.rot0 + l * k.spin + (1 - sc) * -90).toFixed(2)}) scale(${sc.toFixed(4)})`);
				if (k.dash) k.dash.setAttribute("stroke-dashoffset", (k.dash.__len * (1 - quartOut(clamp((l - k.at) / 0.7)))).toFixed(1));
			}
		};
	};
	const contrastHex = (a, b) => {
		const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
		return (x + 0.05) / (y + 0.05);
	};

	/** Style decorations behind a scene's content. Returns a draw(l) for any that move. */
	const decorate = (root, ps) => {
		const look = plan.look ?? {};
		const deco = look.deco ?? {};
		const bgHex = ps.bg === "sky" ? plan.palette.sky : ps.bg;
		const dark = lum(bgHex) < 0.18;
		const draws = [];
		if (deco.grid) {
			// Drafting grid: 60 px cells, every fifth line stronger. Ink depends on the paper.
			const g = el("div", "deco", root);
			const blue = lum(bgHex) < 0.3 && !dark;
			const ink = dark ? plan.palette.lime : blue ? "#ffffff" : plan.palette.electric;
			const cell = 60 * S;
			set(g, {
				backgroundImage: [
					`linear-gradient(${alpha(ink, 0.26)} 1px, transparent 1px)`,
					`linear-gradient(90deg, ${alpha(ink, 0.26)} 1px, transparent 1px)`,
					`linear-gradient(${alpha(ink, 0.12)} 1px, transparent 1px)`,
					`linear-gradient(90deg, ${alpha(ink, 0.12)} 1px, transparent 1px)`,
				].join(","),
				backgroundSize: `${px(cell * 5)} ${px(cell * 5)}, ${px(cell * 5)} ${px(cell * 5)}, ${px(cell)} ${px(cell)}, ${px(cell)} ${px(cell)}`,
				backgroundPosition: "center center",
			});
		}
		if (deco.glow && dark) {
			// Luminous light behind dark scenes: soft blobs in the style's accents, drifting.
			const cols = [plan.palette.electric, plan.palette.lilac, plan.palette.coral];
			const blobs = cols.map((c, i) => {
				const b = el("div", "deco", root);
				const r = (0.55 + hash(i + ps.index * 3) * 0.35) * Math.max(W, H);
				set(b, { inset: "auto", width: px(r), height: px(r), borderRadius: "50%", background: `radial-gradient(circle, ${alpha(c, 0.5)} 0%, ${alpha(c, 0)} 65%)` });
				return { b, r, x: hash(i * 7.3 + ps.index) * W, y: hash(i * 3.9 + ps.index * 2) * H, sp: (hash(i * 2.2) - 0.5) * 120 * S };
			});
			draws.push((l) => {
				for (const k of blobs) set(k.b, { left: px(k.x - k.r / 2 + l * k.sp), top: px(k.y - k.r / 2 - l * k.sp * 0.5) });
			});
		}
		const typeLed = ["title", "fullbleed", "endcard", "logo3d", "slam", "counter", "swap", "highlight"].includes(ps.scene.type);
		if (deco.sunburst && typeLed) {
			// Op-art sunburst turning continuously behind type-led scenes.
			const sb = el("div", "deco", root);
			const ray = lum(bgHex) < 0.4 ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.07)";
			const d = Math.hypot(W, H) * 1.1;
			set(sb, { inset: "auto", left: px(W / 2 - d / 2), top: px(H / 2 - d / 2), width: px(d), height: px(d), borderRadius: "50%", background: `repeating-conic-gradient(${ray} 0deg 6deg, transparent 6deg 15deg)` });
			draws.push((l) => set(sb, { transform: `rotate(${(l * 9 + ps.index * 17).toFixed(3)}deg)` }));
		}
		if (deco.mesh) {
			// Mesh-gradient light: four big soft blobs in the style's colours, orbiting slowly.
			const cols = [plan.palette.electric, plan.palette.coral, plan.palette.lilac, plan.palette.lime];
			const blobs = cols.map((c, i) => {
				const b = el("div", "deco", root);
				const r = (0.7 + hash(i * 1.7 + ps.index) * 0.4) * Math.max(W, H);
				set(b, { inset: "auto", width: px(r), height: px(r), borderRadius: "50%", background: `radial-gradient(circle, ${alpha(c, dark ? 0.55 : 0.42)} 0%, ${alpha(c, 0)} 62%)` });
				return { b, r, a: hash(i * 5.1 + ps.index * 1.3) * Math.PI * 2, rad: (0.18 + hash(i * 9.2) * 0.2) * W };
			});
			draws.push((l) => {
				for (const [i, k] of blobs.entries()) {
					const a = k.a + l * (0.35 + i * 0.08) * (i % 2 ? -1 : 1);
					set(k.b, { left: px(W / 2 + Math.cos(a) * k.rad - k.r / 2), top: px(H / 2 + Math.sin(a) * k.rad * 0.7 - k.r / 2) });
				}
			});
		}
		if (deco.spotlight) {
			// Premium dark: one soft overhead light, a faint floor glow and a dotted grid fading
			// out from the centre, so dark scenes have depth instead of flat black.
			const beam = el("div", "deco", root);
			set(beam, { background: `radial-gradient(ellipse 55% 60% at 50% -8%, ${alpha("#ffffff", 0.13)} 0%, ${alpha(plan.palette.electric, 0.08)} 38%, transparent 70%)` });
			const floor = el("div", "deco", root);
			set(floor, { background: `radial-gradient(ellipse 60% 35% at 50% 108%, ${alpha(plan.palette.lilac, 0.16)} 0%, transparent 70%)` });
			const dots = el("div", "deco", root);
			set(dots, { backgroundImage: `radial-gradient(circle, ${alpha("#ffffff", 0.09)} 1px, transparent 1.5px)`, backgroundSize: `${px(34 * S)} ${px(34 * S)}`, maskImage: "radial-gradient(ellipse 70% 60% at 50% 45%, #000 0%, transparent 75%)", webkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 45%, #000 0%, transparent 75%)" });
			draws.push((l) => {
				set(beam, { opacity: (0.85 + 0.15 * Math.sin(l * 1.3 + ps.index)).toFixed(3) });
				set(dots, { backgroundPosition: `${px(l * 6 * S)} ${px(l * -4 * S)}` });
			});
		}
		if (deco.aurora) {
			// Premium light: two big soft lights in the accent colours, drifting slowly.
			const cols = [plan.palette.electric, plan.palette.lilac];
			const blobs = cols.map((c, i) => {
				const b = el("div", "deco", root);
				const r = (0.75 + hash(i * 3.1 + ps.index) * 0.3) * Math.max(W, H);
				set(b, { inset: "auto", width: px(r), height: px(r), borderRadius: "50%", background: `radial-gradient(circle, ${alpha(c, 0.32)} 0%, ${alpha(c, 0)} 62%)` });
				const side = (i + ps.index) % 2 ? 1 : -1;
				return { b, r, x: W / 2 + side * W * 0.42, y: H * (i ? 0.85 : 0.1) };
			});
			draws.push((l) => {
				for (const [i, k] of blobs.entries()) set(k.b, { left: px(k.x - k.r / 2 + Math.sin(l * 0.5 + i) * 60 * S), top: px(k.y - k.r / 2 + Math.cos(l * 0.4 + i) * 40 * S) });
			});
		}
		if (deco.halftone) {
			// Print dots, biggest in one corner and fading out across the frame.
			const h = el("div", "deco", root);
			const ink = lum(bgHex) < 0.35 ? "rgba(255,255,255,0.22)" : alpha(plan.palette.ink, 0.16);
			const cell = 26 * S;
			const corner = ["135deg", "315deg", "45deg", "225deg"][ps.index % 4];
			set(h, {
				backgroundImage: `radial-gradient(circle, ${ink} 34%, transparent 36%)`,
				backgroundSize: `${px(cell)} ${px(cell)}`,
				maskImage: `linear-gradient(${corner}, transparent 35%, #000 100%)`,
				webkitMaskImage: `linear-gradient(${corner}, transparent 35%, #000 100%)`,
			});
			draws.push((l) => set(h, { backgroundPosition: `${px(l * 14 * S)} ${px(l * 9 * S)}` }));
		}
		if (deco.scanlines) {
			const sl = el("div", "deco", root);
			set(sl, {
				zIndex: "800",
				backgroundImage: `repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0 ${px(2 * S)}, transparent ${px(2 * S)} ${px(5 * S)}), radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)`,
			});
			const bar = el("div", "deco", root);
			set(bar, { zIndex: "801", inset: "auto", left: "0", width: px(W), height: px(H * 0.18), background: `linear-gradient(transparent, ${alpha(plan.palette.lime, 0.05)}, transparent)` });
			draws.push((l) => {
				set(bar, { top: px(((l * 0.35 + ps.index * 0.3) % 1.2) * H * 1.1 - H * 0.2) });
				set(sl, { opacity: (0.85 + 0.15 * Math.sin(l * 40)).toFixed(3) });
			});
		}
		if (deco.numeral && ps.scene.type !== "fullbleed") {
			const n = el("div", "deco", root, String(ps.index + 1).padStart(2, "0"));
			const ink = lum(bgHex) < 0.4 ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.08)";
			set(n, { inset: "auto", left: px(-0.04 * H), bottom: px(-0.12 * H), fontFamily: '"Archivo", sans-serif', fontWeight: "900", fontSize: px(H * 0.62), lineHeight: "1", letterSpacing: "-0.06em", color: ink, fontVariationSettings: '"wdth" 90' });
			draws.push((l) => set(n, { transform: `translateY(${px((1 - expoOut(clamp(l / 0.7))) * H * 0.25)})` }));
		}
		if (deco.floor) draws.push(gridFloor(root, ps));
		if (deco.axes) draws.push(axesPlane(root, ps, bgHex));
		if (deco.shapes) draws.push(popShapes(root, ps, bgHex));
		if (deco.leak) {
			// Light leaks: two warm, blown-out blobs sweeping across the frame, breathing.
			const cols = [plan.palette.lime, plan.palette.coral];
			const leaks = cols.map((c, i) => {
				const b = el("div", "deco", root);
				const r = (0.8 + hash(i * 4.3 + ps.index) * 0.5) * Math.max(W, H);
				set(b, { inset: "auto", width: px(r), height: px(r * 0.7), borderRadius: "50%", mixBlendMode: "screen", background: `radial-gradient(ellipse, ${alpha(c, 0.55)} 0%, ${alpha(c, 0.18)} 35%, ${alpha(c, 0)} 68%)` });
				return { b, r, y: (i ? 0.9 : 0.05) * H, dir: (ps.index + i) % 2 ? 1 : -1, ph: hash(i + ps.index * 2.7) * 6 };
			});
			draws.push((l) => {
				for (const k of leaks) {
					const x = W / 2 + k.dir * (-0.75 + ((l * 0.11 + k.ph * 0.1) % 1.5)) * W;
					set(k.b, { left: px(x - k.r / 2), top: px(k.y - k.r * 0.35), opacity: (0.55 + 0.45 * Math.sin(l * 1.7 + k.ph)).toFixed(3) });
				}
			});
		}
		if (deco.particles) draws.push(particleField(root, ps, deco.particles, bgHex, typeLed || ps.scene.type === "endcard"));
		const vig = look.post?.vignette;
		if (vig) {
			const v = el("div", "deco", root);
			set(v, { zIndex: "799", background: `radial-gradient(ellipse 75% 70% at 50% 50%, transparent 45%, rgba(0,0,0,${(vig * (dark ? 0.85 : 0.35)).toFixed(3)}) 100%)` });
		}
		return (l) => {
			for (const d of draws) d(l);
		};
	};

	/** Cinema bar height: 2:1 scope on landscape, thin bars on square and vertical. */
	const letterboxBar = () => (W / H > 1.3 ? (H - W / 2) / 2 : H * 0.05);

	/** Overlays on every scene: figure labels and a beat counter, poster crumbs, beat ticks. */
	let overlays = [];
	const buildOverlays = () => {
		overlays = [];
		const deco = plan.look?.deco ?? {};
		const label = (pos) => {
			const n = el("div", "overlay-label", stage);
			const m = 54 * S;
			set(n, { fontSize: px(19 * S), ...(pos.includes("t") ? { top: px(m * 0.8) } : { bottom: px(m * 0.8) }), ...(pos.includes("l") ? { left: px(m) } : { right: px(m) }) });
			return n;
		};
		const total = Math.round(plan.duration / plan.beat);
		const two = (x) => String(x).padStart(2, "0");
		if (deco.corners) {
			const tl = label("tl");
			const br = label("br");
			overlays.push((t, ps) => {
				tl.textContent = `FIG. ${two(ps.index + 1)} — ${ps.scene.type.replace("-", " ")}`;
				br.textContent = `BEAT ${two(Math.min(total, Math.floor(t / plan.beat) + 1))} / ${total}`;
				for (const n of [tl, br]) set(n, { color: alpha(ps.fg, 0.75) });
			});
		}
		if (deco.crumbs) {
			const tl = label("tl");
			const tr = label("tr");
			const bl = label("bl");
			const br = label("br");
			overlays.push((t, ps) => {
				tl.textContent = (plan.brand?.name ?? "").toUpperCase();
				tr.textContent = `${two(ps.index + 1)} / ${two(plan.scenes.length)}`;
				bl.textContent = (plan.brand?.url ?? "").toUpperCase();
				br.textContent = `00:${two(Math.floor(t))}:${two(Math.floor(t * 30) % 30)}`;
				for (const n of [tl, tr, bl, br]) set(n, { color: alpha(ps.fg, 0.7) });
			});
		}
		if (deco.letterbox) {
			// Scope bars that slide in as the film starts.
			const bar = letterboxBar();
			const bars = ["top", "bottom"].map((side) => {
				const b = el("div", "", stage);
				set(b, { position: "absolute", left: "0", width: px(W), height: px(bar), [side]: "0", background: "#000", zIndex: "945", transformOrigin: side === "top" ? "50% 0" : "50% 100%" });
				return b;
			});
			overlays.push((t) => {
				const k = expoOut(clamp(t / 0.9)).toFixed(4);
				for (const b of bars) set(b, { transform: `scaleY(${k})` });
			});
		}
		if (deco.ticks) {
			// A row of thin bars along the bottom that kicks on every beat, like a waveform.
			const row = el("div", "", stage);
			set(row, { position: "absolute", left: px(W * 0.3), width: px(W * 0.4), bottom: px(36 * S), height: px(46 * S), display: "flex", alignItems: "flex-end", justifyContent: "space-between", zIndex: "950" });
			const bars = Array.from({ length: 48 }, (_, i) => {
				const b = el("div", "", row);
				set(b, { width: px(3 * S), height: "100%", transformOrigin: "50% 100%" });
				return { b, h: 0.2 + hash(i * 5.5) * 0.8 };
			});
			overlays.push((t, ps) => {
				const kick = Math.exp(-(t % plan.beat) * 7);
				for (const [i, k] of bars.entries()) {
					const wave = 0.5 + 0.5 * Math.sin(t * 6 + i * 0.5);
					set(k.b, { background: ps.accent, transform: `scaleY(${(0.12 + k.h * (0.25 + 0.75 * kick) * (0.6 + 0.4 * wave)).toFixed(3)})` });
				}
			});
		}
	};

	// ---------- shared animation pieces ----------
	/** Per-letter spring rise with rotation, staggered; word starts at wordAt[i] when given. */
	const SCRAMBLE = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+/<>";
	const riseGlyphs = (glyphs, l, { at = 0.04, stagger = 0.032, rise = 0.85, rot = -12, wordAt, mode = TEXT_MODE() } = {}) => {
		const n = glyphs.length;
		const st = Math.min(stagger, 0.55 / Math.max(1, n));
		for (const g of glyphs) {
			const t0 = wordAt ? wordAt[g.word] + (g.i - (g.first ?? 0)) * st : at + g.i * st;
			const dt = l - t0;
			if (mode === "mask") {
				const k = expoOut(clamp(dt / 0.6));
				set(g.node, { opacity: dt > 0 ? "1" : "0", transform: `translateY(${((1 - k) * 1.1).toFixed(4)}em)` });
				continue;
			}
			if (mode === "slam") {
				// Slams down from oversize with a short smear on impact.
				const k = spring(dt, 4.4, 0.55);
				const smear = dt > 0 && dt < 0.1 ? 1 - dt / 0.1 : 0;
				set(g.node, {
					opacity: clamp(dt / 0.03).toFixed(3),
					transform: `translateY(${((1 - k) * -0.3).toFixed(4)}em) scale(${(1 + (1 - k) * 0.75).toFixed(4)})`,
					filter: smear ? `blur(${(smear * 7 * S).toFixed(2)}px)` : "none",
				});
				continue;
			}
			if (mode === "scramble") {
				const ch = dt >= 0.3 || /\s/.test(g.ch ?? "") ? g.ch : SCRAMBLE[Math.floor(hash(g.i * 13.1 + Math.floor(l * 24)) * SCRAMBLE.length)];
				if (g.ch && g.node.textContent !== ch) g.node.textContent = ch;
				set(g.node, { opacity: clamp((dt + 0.1) / 0.05).toFixed(3) });
				continue;
			}
			if (mode === "blur") {
				// Focus pull: each letter sharpens out of a soft, slightly oversized haze.
				const k = expoOut(clamp(dt / 0.75));
				set(g.node, {
					opacity: clamp(dt / 0.35).toFixed(3),
					transform: `translateY(${((1 - k) * 0.12).toFixed(4)}em) scale(${(1 + (1 - k) * 0.14).toFixed(4)})`,
					filter: k < 0.995 ? `blur(${((1 - k) * 0.16).toFixed(4)}em)` : "none",
				});
				continue;
			}
			if (mode === "wave") {
				// Stagger from the centre outward with an elastic overshoot, squashing as it lands.
				const mid = (n - 1) / 2;
				const d0 = wordAt ? t0 : at + Math.abs(g.i - mid) * st * 1.4;
				const e = l - d0;
				const s = spring(e, 2.6, 0.32);
				const squash = 1 + (s - 1) * 0.6;
				set(g.node, {
					opacity: clamp(e / 0.05).toFixed(3),
					transform: `translateY(${((1 - s) * 1.15).toFixed(4)}em) scale(${(2 - squash).toFixed(4)}, ${squash.toFixed(4)})`,
				});
				continue;
			}
			if (mode === "flip") {
				// Each letter flips up out of the floor on its own hinge.
				const s = spring(dt, 2.9, 0.48);
				set(g.node, {
					opacity: clamp(dt / 0.08).toFixed(3),
					transformOrigin: "50% 100%",
					transform: `perspective(6em) rotateX(${((1 - s) * -95).toFixed(3)}deg)`,
				});
				continue;
			}
			if (mode === "draw") {
				// Written on: the outline traces left to right, then the fill floods in.
				const w = quartOut(clamp(dt / 0.55));
				const fill = clamp((dt - 0.4) / 0.35);
				set(g.node, {
					opacity: dt > 0 ? "1" : "0",
					clipPath: w < 1 ? `inset(-0.2em ${((1 - w) * 100).toFixed(2)}% -0.2em -0.1em)` : "none",
					webkitTextStroke: fill < 1 ? `${(0.018 * (1 - fill)).toFixed(4)}em currentColor` : "0",
					webkitTextFillColor: fill < 1 ? `color-mix(in srgb, currentColor ${(fill * 100).toFixed(1)}%, transparent)` : "",
				});
				continue;
			}
			const s = spring(l - t0, 3.2, 0.52);
			const a = clamp((l - t0) / 0.06);
			set(g.node, {
				opacity: a.toFixed(3),
				transform: `translateY(${((1 - s) * rise).toFixed(4)}em) rotate(${((1 - s) * rot).toFixed(3)}deg)`,
			});
		}
	};

	/** Print misregistration on impact frames: the type splits into two accent echoes. */
	const misreg = (node, amount) => {
		if (!plan?.look?.deco?.misreg || amount <= 0.002) {
			if (node.style.textShadow) node.style.textShadow = "";
			return;
		}
		const d = 12 * S * amount;
		node.style.textShadow = `${px(-d)} ${px(d * 0.3)} 0 ${alpha(plan.palette.coral, 0.85 * amount)}, ${px(d)} ${px(-d * 0.3)} 0 ${alpha(plan.palette.lime, 0.85 * amount)}`;
	};

	const mixHex = (a, b, k) => {
		const p = (h) => {
			const x = String(h).replace("#", "");
			const f = x.length === 3 ? x.replace(/./g, (c) => c + c) : x.slice(0, 6);
			const n = Number.parseInt(f, 16);
			return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
		};
		const [x, y] = [p(a), p(b)];
		const c = x.map((v, i) => Math.round(v + (y[i] - v) * clamp(k)));
		return `rgb(${c[0]},${c[1]},${c[2]})`;
	};

	const makeCursor = (parent, size) => {
		const c = el("div", "cursor", parent);
		c.innerHTML = CURSOR_SVG;
		set(c, { width: px(size * 0.74), height: px(size) });
		const ring = el("div", "ring", parent);
		set(ring, { borderWidth: px(size * 0.06), borderColor: "rgba(255,255,255,0.95)" });
		/** Move along an arc from (fx,fy) to (x,y), arrive at `arrive`, click at `click`. */
		return (l, { fx, fy, x, y, start, arrive, click, ringColor }) => {
			const p = expoOut(prog(l, start, arrive - start));
			const visible = l >= start;
			const cx = lerp(fx, x, p) + Math.sin(p * Math.PI) * size * 0.6;
			const cy = lerp(fy, y, p);
			const press = l >= click ? 1 - expoOut(prog(l, click, 0.25)) : 0;
			const down = l >= click - 0.06 && l < click + 0.12 ? 1 : press;
			set(c, {
				opacity: visible ? "1" : "0",
				transform: `translate(${px(cx - size * 0.08)}, ${px(cy - size * 0.06)}) scale(${(1 - 0.16 * down).toFixed(3)})`,
			});
			const rk = prog(l, click, 0.55);
			set(ring, {
				opacity: l >= click && rk < 1 ? (1 - rk).toFixed(3) : "0",
				left: px(x),
				top: px(y),
				width: px(size * (0.4 + expoOut(rk) * 2.6)),
				height: px(size * (0.4 + expoOut(rk) * 2.6)),
				borderColor: ringColor ?? "rgba(255,255,255,0.95)",
			});
		};
	};

	/** Fake app window for UI scenes without a screenshot. */
	/** What mock screens show when the script has no "app" block: plausible, never grey bars. */
	const UI_DEFAULT = {
		kind: "dashboard",
		nav: ["Home", "Inbox", "Projects", "Reports", "Settings"],
		title: "Overview",
		stats: [["Active this week", "2,481"], ["Completed", "184"], ["Time saved", "12h"]],
		rows: [["Maya Chen", "Updated the launch plan"], ["Leo Park", "Shared 3 files"], ["Ava Singh", "Left a comment"], ["Noah Kim", "Joined the workspace"]],
		status: ["Done", "In review", "New", "Live"],
		cta: "New",
	};
	let curPS = null;
	/** A believable product screen: the brand's mark and name, real nav labels, a header with search
	 *  and a button, stat cards, a list with avatars and status pills, and a chart. Content comes
	 *  from the script's app block (written by the AI per product), else the defaults above.
	 *  Light or dark to match the style's paper. Sized to its parent, so it works on a phone too. */
	const mockUI = (parent, palette, sceneAccent, seed, kindOverride) => {
		const ui = { ...UI_DEFAULT, ...(plan.app ?? {}), ...(curPS?.scene?.ui ?? {}) };
		// A real product keeps one brand colour on every screen, whatever the scene's accent is.
		const accent = palette.brand ?? sceneAccent;
		const dark = lum(palette.paper) < 0.2;
		const T = dark
			? { bg: "#0d0f15", side: "#0a0c11", card: "#141720", line: "rgba(255,255,255,0.07)", text: "#eef0f6", mute: "#878ea0", soft: "rgba(255,255,255,0.05)" }
			: { bg: "#ffffff", side: "#f6f7f9", card: "#ffffff", line: "rgba(12,14,22,0.08)", text: "#0d0f14", mute: "#6b7180", soft: "rgba(12,14,22,0.035)" };
		const brandC = palette.brand ?? accent;
		const pw = parent.offsetWidth || W * 0.6;
		const ph = parent.offsetHeight || H * 0.6;
		const narrow = pw / Math.max(1, ph) < 0.8;
		// Phone screens use phone-sized type, not a shrunken desktop.
		const u = narrow ? pw / 400 : pw / 1150;
		const f = (n) => px(n * u);
		const m = el("div", "mock", parent);
		set(m, { display: "grid", gridTemplateColumns: narrow ? "1fr" : "21% 1fr", background: T.bg, color: T.text, fontFamily: '"Geist", system-ui, sans-serif', fontSize: f(17), letterSpacing: "-0.01em", textAlign: "left", lineHeight: "1.3" });
		const initials = (n) => n.split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
		const pill = (parentEl, text, i) => {
			const cols = ["#16a34a", "#d97706", "#2563eb", "#7c3aed"];
			const c = cols[i % cols.length];
			const b = el("span", "", parentEl, text);
			set(b, { flex: "none", fontSize: f(13), fontWeight: "600", padding: `${f(4)} ${f(10)}`, borderRadius: f(99), color: c, background: alpha(c, dark ? 0.18 : 0.11) });
			return b;
		};
		if (!narrow) {
			const side = el("div", "", m);
			set(side, { background: T.side, borderRight: `1px solid ${T.line}`, padding: `${f(22)} ${f(16)}`, display: "flex", flexDirection: "column", gap: f(4) });
			const logo = el("div", "", side);
			set(logo, { display: "flex", alignItems: "center", gap: f(10), fontWeight: "700", fontSize: f(18), marginBottom: f(18), padding: `0 ${f(6)}`, whiteSpace: "nowrap", overflow: "hidden" });
			const mk = el("span", "", logo, (plan.brand?.name ?? "K").trim().charAt(0).toUpperCase());
			set(mk, { flex: "none", width: f(28), height: f(28), borderRadius: f(8), background: brandC, color: textOn(brandC), display: "grid", placeItems: "center", fontSize: f(15), fontWeight: "800" });
			el("span", "", logo, plan.brand?.name ?? "");
			ui.nav.forEach((label, i) => {
				const it = el("div", "", side);
				set(it, { display: "flex", alignItems: "center", gap: f(10), padding: `${f(9)} ${f(10)}`, borderRadius: f(9), fontSize: f(15), fontWeight: i === 0 ? "600" : "500", color: i === 0 ? T.text : T.mute, background: i === 0 ? alpha(accent, dark ? 0.16 : 0.1) : "transparent", whiteSpace: "nowrap" });
				const ic = el("span", "", it);
				set(ic, { flex: "none", width: f(15), height: f(15), borderRadius: f(4), border: `${f(2)} solid ${i === 0 ? accent : T.mute}`, opacity: i === 0 ? "1" : "0.6" });
				el("span", "", it, label);
			});
		}
		const main = el("div", "", m);
		set(main, { padding: narrow ? `${f(26)} ${f(20)}` : `${f(24)} ${f(28)}`, display: "flex", flexDirection: "column", gap: f(18), minWidth: "0", overflow: "hidden" });
		const head = el("div", "", main);
		set(head, { display: "flex", alignItems: "center", gap: f(12) });
		const h1 = el("div", "", head, ui.title);
		set(h1, { fontSize: f(narrow ? 30 : 26), fontWeight: "700", letterSpacing: "-0.025em", flex: "1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
		if (!narrow) {
			const search = el("div", "", head, "Search…");
			set(search, { width: f(200), padding: `${f(8)} ${f(12)}`, borderRadius: f(9), border: `1px solid ${T.line}`, color: T.mute, fontSize: f(14), background: T.soft });
		}
		const cta = el("div", "", head, ui.cta);
		set(cta, { padding: `${f(8)} ${f(14)}`, borderRadius: f(9), background: accent, color: textOn(accent), fontWeight: "600", fontSize: f(14), whiteSpace: "nowrap", boxShadow: `0 ${f(4)} ${f(14)} ${alpha(accent, 0.35)}` });
		const card = (parentEl, extra = {}) => {
			const c = el("div", "", parentEl);
			set(c, { background: T.card, border: `1px solid ${T.line}`, borderRadius: f(14), boxShadow: dark ? "none" : `0 ${f(2)} ${f(10)} rgba(12,14,22,0.05)`, ...extra });
			return c;
		};
		const kind = kindOverride ?? ui.kind ?? "dashboard";
		if (kind === "dashboard") {
			const stats = el("div", "", main);
			const shown = ui.stats.slice(0, narrow ? 2 : 3);
			set(stats, { display: "grid", gridTemplateColumns: narrow ? "1fr" : `repeat(${shown.length}, 1fr)`, gap: f(14) });
			shown.forEach(([label, value], i) => {
				const c = card(stats, { padding: `${f(16)} ${f(18)}` });
				const l = el("div", "", c, label);
				set(l, { fontSize: f(13.5), color: T.mute, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
				const row = el("div", "", c);
				set(row, { display: "flex", alignItems: "baseline", gap: f(10), marginTop: f(6) });
				const v = el("div", "", row, value);
				set(v, { fontSize: f(30), fontWeight: "700", letterSpacing: "-0.03em" });
				const d = el("span", "", row, `▲ ${4 + Math.round(hash(i + seed) * 20)}%`);
				set(d, { fontSize: f(12.5), fontWeight: "600", color: "#16a34a" });
			});
		}
		const bottom = el("div", "", main);
		set(bottom, { display: "grid", gridTemplateColumns: narrow || kind !== "dashboard" ? "1fr" : "1.45fr 1fr", gap: f(14), flex: "1", minHeight: "0" });
		if (kind === "chat") {
			const c = card(bottom, { padding: f(18), display: "flex", flexDirection: "column", gap: f(12) });
			ui.rows.slice(0, 4).forEach(([name, text], i) => {
				const me = i % 2 === 1;
				const b = el("div", "", c, text);
				set(b, { alignSelf: me ? "flex-end" : "flex-start", maxWidth: "72%", padding: `${f(10)} ${f(14)}`, borderRadius: f(16), fontSize: f(15), background: me ? accent : T.soft, color: me ? textOn(accent) : T.text, border: me ? "none" : `1px solid ${T.line}` });
				if (!me) {
					const n = el("div", "", b, name);
					set(n, { fontSize: f(12), color: T.mute, marginTop: f(4) });
				}
			});
		} else if (kind === "editor") {
			const c = card(bottom, { padding: `${f(22)} ${f(26)}`, display: "flex", flexDirection: "column", gap: f(12) });
			ui.rows.slice(0, 5).forEach(([name, text], i) => {
				const ln = el("div", "", c);
				set(ln, { fontSize: f(i === 0 ? 22 : 15.5), fontWeight: i === 0 ? "700" : "400", color: i === 0 ? T.text : T.mute, lineHeight: "1.5" });
				if (i === 0) ln.textContent = name;
				else {
					el("span", "", ln, `${name} `);
					const hl = el("span", "", ln, text);
					set(hl, { background: i === 2 ? alpha(accent, 0.25) : "transparent", color: i === 2 ? T.text : T.mute, borderRadius: f(4), padding: `0 ${f(3)}` });
				}
			});
		} else {
			const list = card(bottom, { padding: f(6), display: "flex", flexDirection: "column", overflow: "hidden" });
			const avCols = [palette.electric, palette.coral, palette.lime, palette.lilac, palette.peach];
			ui.rows.slice(0, narrow ? 4 : kind === "inbox" ? 5 : 4).forEach(([name, detail], i) => {
				const r = el("div", "", list);
				set(r, { display: "flex", alignItems: "center", gap: f(12), padding: `${f(11)} ${f(12)}`, borderBottom: `1px solid ${T.line}`, minWidth: "0" });
				const ac = avCols[(i + seed) % avCols.length] ?? accent;
				const av = el("span", "", r, initials(name));
				set(av, { flex: "none", width: f(34), height: f(34), borderRadius: "50%", background: ac, color: textOn(ac), display: "grid", placeItems: "center", fontSize: f(13), fontWeight: "700" });
				const tx = el("div", "", r);
				set(tx, { flex: "1", minWidth: "0" });
				const n = el("div", "", tx, name);
				set(n, { fontSize: f(15), fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
				const d = el("div", "", tx, detail);
				set(d, { fontSize: f(13), color: T.mute, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
				pill(r, ui.status[i % ui.status.length], i);
			});
			if (kind === "dashboard" && !narrow) {
				const ch = card(bottom, { padding: `${f(16)} ${f(18)}`, display: "flex", flexDirection: "column" });
				const t = el("div", "", ch, ui.stats[0]?.[0] ?? "Activity");
				set(t, { fontSize: f(13.5), color: T.mute });
				const bars = el("div", "", ch);
				set(bars, { flex: "1", display: "flex", alignItems: "flex-end", gap: f(7), marginTop: f(12), minHeight: f(90) });
				for (let i = 0; i < 12; i++) {
					const b = el("div", "", bars);
					const h = 25 + 70 * (0.35 + 0.65 * hash(i * 1.7 + seed)) * (0.55 + i / 24);
					set(b, { flex: "1", height: `${Math.min(100, h)}%`, borderRadius: f(5), background: i === 11 ? accent : alpha(accent, dark ? 0.35 : 0.22) });
				}
			}
		}
		if (narrow) {
			// A phone's tab bar: the first four nav labels, the current one in the brand colour.
			const tabs = el("div", "", m);
			set(tabs, { position: "absolute", left: "0", right: "0", bottom: "0", display: "flex", justifyContent: "space-around", padding: `${f(10)} ${f(8)} ${f(18)}`, borderTop: `1px solid ${T.line}`, background: T.bg });
			ui.nav.slice(0, 4).forEach((label, i) => {
				const t = el("div", "", tabs);
				set(t, { display: "flex", flexDirection: "column", alignItems: "center", gap: f(4), fontSize: f(11), fontWeight: "600", color: i === 0 ? accent : T.mute });
				const ic = el("span", "", t);
				set(ic, { width: f(18), height: f(18), borderRadius: f(5), border: `${f(2)} solid currentColor` });
				el("span", "", t, label);
			});
		}
		return m;
	};

	// ---------- scenes ----------
	const SCENES = {};

	SCENES.title = ({ p, cam, fg, accent }) => {
		const s = p.scene;
		const ghost = el("div", "ghost", cam, plain(s.text));
		set(ghost, { color: fg, opacity: "0.05" });
		fitLine(ghost, W * 1.7, H * 0.9);
		const wrap = el("div", "center", cam);
		let label = null;
		if (s.sub) {
			label = el("div", "mono", wrap, "");
			set(label, { fontSize: px(30 * S), color: fg, marginBottom: px(34 * S), opacity: "0.85" });
		}
		const line = el("div", "display", wrap);
		set(line, { color: fg });
		const { glyphs, words } = glyphText(line, s.text);
		for (const w of words)
			if (w.accent) {
				w.node.style.color = accent;
				if (plan.look?.display?.accent === "serif") w.node.classList.add("serif");
			}
		fit(line, W * 0.86, H * (s.sub ? 0.52 : 0.64), 460 * S);
		const landed = 0.03 + Math.min(0.032, 0.55 / Math.max(1, glyphs.length)) * glyphs.length;
		return (l, d) => {
			riseGlyphs(glyphs, l, { at: 0.03 });
			misreg(line, l > landed - 0.05 ? 1 - prog(l, landed, 0.22) : 0);
			if (label) {
				const n = Math.floor(clamp(l / 0.5) * s.sub.length);
				label.textContent = s.sub.slice(0, n);
			}
			set(ghost, {
				transform: `translate(-50%,-50%) translateX(${px(lerp(0.06, -0.06, l / d) * W)})`,
			});
		};
	};

	SCENES.highlight = ({ p, cam, fg, accent }) => {
		const s = p.scene;
		const wrap = el("div", "center", cam);
		const line = el("div", "bold", wrap);
		set(line, { color: fg });
		const { words } = glyphText(line, s.text, { glyphs: false });
		const markText = textOn(accent);
		const marks = [];
		for (const w of words) {
			if (!w.accent) continue;
			const text = w.node.textContent;
			w.node.textContent = "";
			const mw = el("span", "markword", w.node, text);
			const m = el("span", "mark", mw);
			m.style.background = accent;
			marks.push({ w, mw, m });
		}
		if (!marks.length && words.length) {
			// No marked word: mark the longest one.
			const w = [...words].sort((a, b) => b.text.length - a.text.length)[0];
			const text = w.node.textContent;
			w.node.textContent = "";
			const mw = el("span", "markword", w.node, text);
			const m = el("span", "mark", mw);
			m.style.background = accent;
			marks.push({ w, mw, m });
		}
		let sub = null;
		if (s.sub) {
			sub = el("div", "bold", wrap, s.sub);
			set(sub, { color: fg, fontWeight: "640", marginTop: px(30 * S), letterSpacing: "-0.02em" });
		}
		const size = fit(line, W * 0.84, H * (s.sub ? 0.5 : 0.62), 240 * S);
		if (sub) sub.style.fontSize = px(Math.max(30 * S, size * 0.32));
		const ghostWord = plain(marks[0]?.w.text ?? "");
		const ghost = el("div", "ghost", cam, ghostWord);
		cam.insertBefore(ghost, cam.firstChild);
		set(ghost, { color: fg, opacity: "0.06" });
		fitLine(ghost, W * 1.4, H * 1.1);
		const step = Math.min(0.11, 0.6 / Math.max(1, words.length));
		const markAt = 0.12 + words.length * step + 0.05;
		return (l, d) => {
			for (const w of words) {
				const t0 = 0.04 + w.index * step;
				const k = spring(l - t0, 3, 0.55);
				set(w.node, {
					opacity: clamp((l - t0) / 0.08).toFixed(3),
					transform: `translateY(${((1 - k) * 0.45).toFixed(4)}em)`,
					filter: `blur(${px((1 - clamp(k)) * 10 * S)})`,
				});
			}
			marks.forEach(({ m, mw }, i) => {
				const k = expoOut(prog(l, markAt + i * 0.12, 0.42));
				set(m, { transform: `scaleX(${k.toFixed(4)}) rotate(-1.2deg)` });
				set(mw, { color: k > 0.45 ? markText : fg });
			});
			if (sub) {
				const k = expoOut(prog(l, markAt + 0.18, 0.4));
				set(sub, { opacity: k.toFixed(3), transform: `translateY(${px((1 - k) * 30 * S)})` });
			}
			set(ghost, { transform: `translate(-50%,-50%) translateX(${px(lerp(-0.05, 0.05, l / d) * W)})` });
		};
	};

	SCENES.swap = ({ p, cam, fg, accent }) => {
		const s = p.scene;
		const vertical = H > W * 1.2;
		const wrap = el("div", "center", cam);
		const row = el("div", "bold", wrap);
		set(row, {
			display: "flex",
			flexDirection: vertical ? "column" : "row",
			alignItems: "center",
			gap: "0.22em",
			color: fg,
			whiteSpace: "nowrap",
		});
		const lead = el("span", "", row);
		const leadG = glyphText(lead, s.lead).glyphs;
		const slot = el("span", "", row);
		set(slot, { position: "relative", display: "inline-block", height: "1.2em" });
		const from = el("span", "", slot, s.from);
		set(from, { position: "absolute", left: "0", top: "0.1em", whiteSpace: "nowrap" });
		const pill = el("span", "pill", slot, s.to);
		set(pill, {
			position: "absolute",
			left: "0",
			top: "0",
			background: accent,
			color: textOn(accent),
			padding: "0.06em 0.34em 0.14em",
			lineHeight: "1",
			height: "1.2em",
			boxSizing: "border-box",
			transformOrigin: "30% 60%",
		});
		// Measure at 100px to size the line to the wider of the two states.
		row.style.fontSize = "100px";
		const leadW = lead.offsetWidth;
		const fromW = from.offsetWidth;
		const pillW = pill.offsetWidth;
		const widest = vertical ? Math.max(leadW, fromW, pillW) : leadW + Math.max(fromW, pillW) + 22;
		const size = Math.min(230 * S, (100 * W * 0.88) / widest, (100 * H * (vertical ? 0.38 : 0.6)) / 120);
		row.style.fontSize = px(size);
		const k = size / 100;
		const swapAt = Math.max(0.55, p.dur * 0.42);
		return (l) => {
			riseGlyphs(leadG, l, { at: 0.02, stagger: 0.025, rot: -6 });
			const fIn = spring(l - 0.12, 3, 0.6);
			const fOut = expoIn(prog(l, swapAt - 0.05, 0.22));
			set(from, {
				opacity: (clamp((l - 0.12) / 0.08) * (1 - fOut)).toFixed(3),
				transform: `translateY(${((1 - fIn) * 0.5 - fOut * 0.9).toFixed(4)}em)`,
				filter: `blur(${px(fOut * 12 * S)})`,
			});
			const pk = spring(l - swapAt, 3.4, 0.45);
			set(pill, {
				opacity: l >= swapAt ? "1" : "0",
				transform: `translateY(${((1 - clamp(pk)) * 0.5).toFixed(4)}em) scale(${(0.5 + 0.5 * pk).toFixed(4)}) rotate(${((1 - pk) * -8).toFixed(3)}deg)`,
			});
			const w = lerp(fromW, pillW, clamp(spring(l - swapAt, 2.6, 0.7)));
			set(slot, { width: px(w * k) });
		};
	};

	SCENES.fullbleed = ({ p, cam, fg }) => {
		const s = p.scene;
		if (s.variant === "repeat") {
			const rows = [];
			const n = H > W ? 7 : 5;
			const box = el("div", "", cam);
			set(box, { position: "absolute", inset: "0", display: "flex", flexDirection: "column", justifyContent: "center" });
			for (let i = 0; i < n; i++) {
				const r = el("div", "display", box, `${s.text} ${s.text} ${s.text} ${s.text} ${s.text}`);
				set(r, { whiteSpace: "nowrap", color: fg, lineHeight: "0.86" });
				// Echo rows: the same word, faint. (Outline strokes show a variable font's
				// internal contours, so the echoes are tinted instead.)
				if (i !== Math.floor(n / 2)) r.style.color = alpha(fg, 0.17);
				rows.push(r);
			}
			const size = (H / n) * 1.08;
			for (const r of rows) r.style.fontSize = px(size);
			return (l) => {
				rows.forEach((r, i) => {
					const dir = i % 2 ? 1 : -1;
					const k = expoOut(prog(l, i * 0.04, 0.5));
					set(r, {
						transform: `translateX(${px(-W * 0.6 + dir * (l * 120 * S + (1 - k) * 300 * S))})`,
						opacity: k.toFixed(3),
					});
				});
			};
		}
		const wrap = el("div", "center", cam);
		const line = el("div", "display", wrap);
		set(line, { color: fg, lineHeight: "0.8", overflow: "hidden", padding: "0.04em 0.08em 0.06em" });
		const { glyphs } = glyphText(line, s.text);
		fitLine(line, W * 0.92, H * 0.8);
		return (l, d) => {
			const st = Math.min(0.035, 0.32 / Math.max(1, glyphs.length));
			for (const g of glyphs) {
				const k = expoOut(prog(l, g.i * st, 0.42));
				set(g.node, { transform: `translateY(${((1 - k) * 1.05).toFixed(4)}em)` });
			}
			set(wrap, { transform: `scale(${(1 + 0.05 * (l / d)).toFixed(4)})` });
		};
	};

	SCENES.grid = ({ p, cam, fg, accent, palette }) => {
		const s = p.scene;
		const n = s.words.length;
		const vertical = H > W * 1.2;
		const square = !vertical && W < H * 1.3;
		let cols;
		if (vertical) cols = n <= 3 ? 1 : 2;
		else if (square) cols = n <= 4 ? 2 : 3;
		else cols = n <= 3 ? n : n === 4 ? 2 : 3;
		if (square && n === 3) cols = 1;
		const rows = Math.ceil(n / cols);
		const pad = 56 * S;
		const gap = 16 * S;
		const tw = (W - pad * 2 - gap * (cols - 1)) / cols;
		const th = (H - pad * 2 - gap * (rows - 1)) / rows;
		const ink = palette.ink;
		const paper = palette.paper;
		const fills = [ink, paper, accent, paper, ink, accent];
		const tiles = s.words.map((word, i) => {
			const c = i % cols;
			const r = Math.floor(i / cols);
			const t = el("div", "tile", cam);
			const bg = fills[(i + (r % 2)) % fills.length];
			set(t, {
				left: px(pad + c * (tw + gap)),
				top: px(pad + r * (th + gap)),
				width: px(tw),
				height: px(th),
				background: bg,
				borderRadius: px(26 * S),
				color: textOn(bg),
			});
			const idx = el("div", "idx", t, String(i + 1).padStart(2, "0"));
			set(idx, { left: px(22 * S), top: px(18 * S), fontSize: px(22 * S) });
			const w = el("div", "display", t, word);
			fitLine(w, tw * 0.82, th * 0.62, 300 * S);
			return { t, w };
		});
		cam.parentNode.style.perspective = px(2400 * S);
		const st = Math.min(p.beatLen / 2, (p.dur * 0.55) / n);
		return (l) => {
			tiles.forEach(({ t, w }, i) => {
				const t0 = i * st;
				const k = spring(l - t0, 2.8, 0.6);
				set(t, {
					opacity: clamp((l - t0) / 0.05).toFixed(3),
					transform: `rotateX(${((1 - k) * -75).toFixed(3)}deg) scale(${(0.86 + 0.14 * k).toFixed(4)})`,
				});
				const wk = expoOut(prog(l, t0 + 0.06, 0.4));
				set(w, { transform: `translateY(${((1 - wk) * 0.6).toFixed(4)}em)` });
			});
		};
	};

	SCENES.wall = ({ p, cam, palette }) => {
		const s = p.scene;
		const imgs = (s.images ?? []).map((u) => images[u]).filter(Boolean);
		const brand = plan.brand?.name ?? "Kinetic";
		const words = s.words?.length ? s.words : [brand, "LAUNCH", "MOTION", "NOW", "FAST", "EASE", "BOLD", "HELLO"];
		const vertical = H > W * 1.2;
		const cols = vertical ? 5 : 7;
		const rows = vertical ? 7 : 5;
		const cw = (vertical ? W * 0.46 : W * 0.25);
		const ch = cw * 0.64;
		const gap = cw * 0.07;
		const persp = el("div", "", cam);
		set(persp, { position: "absolute", inset: "0", perspective: px(1800 * S) });
		const plane = el("div", "plane", persp);
		const colors = [palette.lime, palette.ink, palette.peach, palette.electric, palette.paper, palette.sage, palette.coral, palette.butter, palette.lilac];
		const cards = [];
		const cx = (cols - 1) / 2;
		const cy = (rows - 1) / 2;
		for (let r = 0; r < rows; r++)
			for (let c = 0; c < cols; c++) {
				const i = r * cols + c;
				const hero = c === Math.round(cx) && r === Math.round(cy);
				const card = el("div", "card", plane);
				set(card, {
					left: px((c - cx) * (cw + gap) - cw / 2),
					top: px((r - cy) * (ch + gap) - ch / 2),
					width: px(cw),
					height: px(ch),
					borderRadius: px(cw * 0.045),
					boxShadow: `0 ${px(cw * 0.03)} ${px(cw * 0.08)} rgba(0,0,0,0.18)`,
				});
				const useImg = imgs.length && (hero || hash(i * 5.1) < 0.55);
				if (useImg) {
					const im = el("img", "fill", card);
					im.src = (hero ? imgs[0] : imgs[i % imgs.length]).src;
				} else {
					const bg = colors[Math.floor(hash(i * 2.3) * colors.length)];
					card.style.background = bg;
					const w = el("div", "display", card, hero ? brand : words[i % words.length]);
					set(w, { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", color: textOn(bg) });
					fitLine(w, cw * 0.8, ch * 0.5, cw * 0.3);
					w.style.width = px(cw);
					w.style.height = px(ch);
				}
				cards.push({ card, hero, phase: hash(i) });
			}
		const startScale = Math.min(W / cw, H / ch) * 0.92;
		return (l, d) => {
			const k = expoInOut(prog(l, 0.08, Math.min(1.1, d * 0.5)));
			const scale = lerp(startScale, vertical ? 0.95 : 1.05, k);
			const rx = lerp(0, 26, k);
			const rz = lerp(0, -11, k);
			const drift = l * 60 * S;
			set(plane, {
				transform: `translate(${px(W / 2 - drift)}, ${px(H / 2 + drift * 0.3)}) rotateX(${rx.toFixed(3)}deg) rotateZ(${rz.toFixed(3)}deg) scale(${scale.toFixed(4)})`,
			});
			for (const c of cards) {
				if (c.hero) continue;
				const a = clamp((k - 0.05 - c.phase * 0.4) / 0.3);
				set(c.card, { opacity: a.toFixed(3) });
			}
		};
	};

	SCENES.prompt = ({ p, cam, accent }) => {
		const s = p.scene;
		const vertical = H > W * 1.2;
		const bw = vertical ? W * 0.86 : Math.min(W * 0.6, 1180 * S);
		const bh = bw * (vertical ? 0.5 : 0.3);
		const chat = el("div", "chat", cam);
		const left = (W - bw) / 2;
		const top = (H - bh) / 2;
		set(chat, { left: px(left), top: px(top), width: px(bw), height: px(bh), borderRadius: px(bw * 0.035), padding: px(bw * 0.034) });
		const text = el("div", "chat-text", chat);
		const fs = bw * 0.042;
		set(text, { fontSize: px(fs) });
		const typed = el("span", "", text);
		const caret = el("span", "caret", text);
		set(caret, { width: px(fs * 0.07), height: px(fs * 1.05), marginLeft: px(fs * 0.06) });
		const hint = el("span", "", text, s.placeholder ?? "Describe your launch video…");
		set(hint, { color: "#9a9ca6", position: "absolute" });
		const row = el("div", "chat-row", chat);
		const tools = el("div", "chat-tools", row);
		set(tools, { gap: px(bw * 0.012) });
		const plus = el("div", "chip", tools);
		plus.innerHTML = PLUS;
		set(plus, { width: px(bw * 0.05), height: px(bw * 0.05), justifyContent: "center" });
		const chip = el("div", "chip", tools, `${plan.brand?.name ?? "Kinetic"} · ${plan.look?.name ?? "Editorial"}`);
		set(chip, { fontSize: px(bw * 0.02), padding: `0 ${px(bw * 0.018)}`, height: px(bw * 0.05) });
		const send = el("div", "send", row);
		send.innerHTML = ARROW_UP;
		const sd = bw * 0.062;
		set(send, { width: px(sd), height: px(sd) });
		const sendX = left + bw - bw * 0.034 - sd / 2;
		const sendY = top + bh - bw * 0.034 - sd / 2;
		const cursor = makeCursor(cam, 70 * S);
		const clickAt = p.clickAt ?? p.dur * 0.74;
		const typeEnd = Math.max(0.5, clickAt - 0.5);
		const focusX = left + bw * 0.42;
		const focusY = top + bh * 0.45;
		return (l) => {
			// The opener is never an empty frame: the box is already rising at t = 0.
			const e = spring(l + 0.14, 2.4, 0.7);
			set(chat, { transform: `translateY(${px((1 - e) * 80 * S)}) scale(${(0.94 + 0.06 * e).toFixed(4)})`, opacity: clamp(0.35 + l / 0.1).toFixed(3) });
			const n = Math.round(clamp((l - 0.25) / (typeEnd - 0.25)) * s.text.length);
			typed.textContent = s.text.slice(0, n);
			set(hint, { opacity: n === 0 ? "1" : "0" });
			set(caret, { opacity: n < s.text.length || Math.floor(l * 2.5) % 2 === 0 ? "1" : "0" });
			const pressed = l >= clickAt;
			set(send, { background: pressed ? accent : "#15161a", transform: `scale(${(1 - 0.12 * (l >= clickAt && l < clickAt + 0.12 ? 1 : 0)).toFixed(3)})` });
			cursor(l, {
				fx: sendX + 260 * S,
				fy: sendY + 300 * S,
				x: sendX,
				y: sendY,
				start: clickAt - 0.55,
				arrive: clickAt - 0.08,
				click: clickAt,
				ringColor: alpha(accent === "#ffffff" ? "#111111" : accent, 0.9),
			});
			// The camera crops in on the words as they type, then pulls to the send button.
			const z = lerp(1, vertical ? 1.15 : 1.42, cubicInOut(prog(l, 0.2, typeEnd)));
			const toSend = cubicInOut(prog(l, clickAt - 0.6, 0.5));
			const fx = lerp(focusX, sendX - bw * 0.15, toSend);
			const fy = lerp(focusY, sendY - bh * 0.15, toSend);
			const cx = lerp(W / 2, fx, clamp((z - 1) * 3));
			const cy = lerp(H / 2, fy, clamp((z - 1) * 3));
			set(cam, { transform: `translate(${px(W / 2 - cx * z)}, ${px(H / 2 - cy * z)}) scale(${z.toFixed(4)})` });
		};
	};

	SCENES["ui-macro"] = (ctx) => {
		const { p, cam, accent, palette, fg } = ctx;
		const s = p.scene;
		const img = s.image ? images[s.image] : null;
		if (!img && !s.target) {
			// No screenshot: the prompt box plays the typing beat instead.
			return SCENES.prompt({ ...ctx, p: { ...p, scene: { ...s, text: s.typeText ?? "Make it pop" } } });
		}
		const vertical = H > W * 1.2;
		const aspect = img ? img.w / img.h : 16 / 10;
		let cw = W * (vertical ? 0.9 : 0.8);
		let ch = cw / aspect;
		if (ch > H * 0.82) {
			ch = H * 0.82;
			cw = ch * aspect;
		}
		const left = (W - cw) / 2;
		const top = (H - ch) / 2;
		const card = el("div", "card", cam);
		set(card, {
			left: px(left),
			top: px(top),
			width: px(cw),
			height: px(ch),
			borderRadius: px(18 * S),
			boxShadow: `0 ${px(40 * S)} ${px(100 * S)} rgba(0,0,0,0.28), 0 0 0 ${px(1.5 * S)} ${alpha(fg, 0.12)}`,
		});
		if (img) {
			const im = el("img", "fill", card);
			im.src = img.src;
		} else mockUI(card, palette, accent, p.index);
		const tg = s.target ?? { x: 0.3, y: 0.42, w: 0.4, h: 0.09 };
		const tx = left + tg.x * cw;
		const ty = top + tg.y * ch;
		const tw = tg.w * cw;
		const th = tg.h * ch;
		let field = null;
		let typed = null;
		if (s.typeText) {
			field = el("div", "", cam);
			set(field, {
				position: "absolute",
				left: px(tx),
				top: px(ty),
				width: px(tw),
				height: px(th),
				background: "#ffffff",
				borderRadius: px(Math.min(th / 2, 14 * S)),
				boxShadow: `0 0 0 ${px(2 * S)} ${alpha(accent, 0.9)}`,
				display: "flex",
				alignItems: "center",
				padding: `0 ${px(th * 0.3)}`,
				boxSizing: "border-box",
				overflow: "hidden",
				color: "#15161a",
				fontWeight: "500",
				fontSize: px(th * 0.42),
				whiteSpace: "nowrap",
				letterSpacing: "-0.01em",
			});
			typed = el("span", "", field);
			const caret = el("span", "caret", field);
			set(caret, { width: px(th * 0.04), height: px(th * 0.5), marginLeft: px(th * 0.05) });
		}
		const flash = el("div", "", cam);
		set(flash, { position: "absolute", left: px(tx), top: px(ty), width: px(tw), height: px(th), borderRadius: px(10 * S), background: accent, mixBlendMode: "multiply" });
		const zoom = clamp((W * (vertical ? 0.8 : 0.55)) / tw, 1.4, 3.6);
		const clickX = tx + tw * (s.typeText ? 0.92 : 0.5);
		const clickY = ty + th * 0.5;
		const cursor = makeCursor(cam, 40 * S);
		const clickAt = p.clickAt ?? p.dur * 0.74;
		const typeEnd = Math.max(0.6, clickAt - 0.45);
		return (l, d) => {
			const e = expoInOut(prog(l, 0.12, 0.7));
			const z = lerp(1, zoom, e);
			const cx = lerp(W / 2, tx + tw / 2, e);
			const cy = lerp(H / 2, ty + th / 2, e);
			const after = expoInOut(prog(l, clickAt + 0.15, d - clickAt));
			const z2 = z * (1 + after * 0.12);
			set(cam, { transform: `translate(${px(W / 2 - cx * z2)}, ${px(H / 2 - cy * z2)}) scale(${z2.toFixed(4)})` });
			if (field) {
				const n = Math.round(clamp((l - 0.55) / (typeEnd - 0.55)) * s.typeText.length);
				typed.textContent = s.typeText.slice(0, n);
				set(field, { opacity: clamp((l - 0.45) / 0.1).toFixed(3) });
			}
			set(flash, { opacity: l >= clickAt ? ((1 - prog(l, clickAt, 0.4)) * 0.35).toFixed(3) : "0" });
			if (s.click !== false)
				cursor(l, {
					fx: clickX + 140 * S,
					fy: clickY + 170 * S,
					x: clickX,
					y: clickY,
					start: clickAt - 0.5,
					arrive: clickAt - 0.06,
					click: clickAt,
					ringColor: alpha(accent, 0.95),
				});
		};
	};

	SCENES["ui-float"] = ({ p, cam, root, fg, accent, palette }) => {
		const s = p.scene;
		const img = s.image ? images[s.image] : null;
		const vertical = H > W * 1.2;
		if (img) {
			const back = el("img", "fill", root);
			back.src = img.src;
			set(back, { position: "absolute", inset: "0", width: "100%", height: "100%", filter: `blur(${px(46 * S)}) saturate(1.2)`, opacity: "0.5", transform: "scale(1.25)" });
			root.insertBefore(back, cam);
		}
		const persp = el("div", "", cam);
		set(persp, { position: "absolute", inset: "0", perspective: px(2200 * S) });
		let cap = null;
		let capG = [];
		const capH = s.caption ? H * (vertical ? 0.2 : 0.17) : 0;
		if (s.caption) {
			cap = el("div", "display", cam);
			set(cap, { position: "absolute", left: "0", right: "0", top: px(H * (vertical ? 0.1 : 0.07)), textAlign: "center", color: fg, margin: "0 auto" });
			capG = glyphText(cap, s.caption).glyphs;
			fit(cap, W * 0.86, capH, 150 * S);
		}
		const aspect = img ? img.w / img.h : 16 / 10;
		const availH = H - capH - H * (s.caption ? 0.2 : 0.14);
		let cw = W * (vertical ? 0.88 : 0.7);
		let ch = cw / aspect;
		if (ch > availH) {
			ch = availH;
			cw = ch * aspect;
		}
		const card = el("div", "card", persp);
		const top = s.caption ? H * (vertical ? 0.1 : 0.07) + capH + H * 0.05 : (H - ch) / 2;
		set(card, {
			left: px((W - cw) / 2),
			top: px(top),
			width: px(cw),
			height: px(ch),
			borderRadius: px(22 * S),
			boxShadow: `0 ${px(50 * S)} ${px(120 * S)} rgba(0,0,0,0.32), 0 0 0 ${px(1.5 * S)} ${alpha(fg, 0.1)}`,
			transformOrigin: "50% 100%",
		});
		if (img) {
			const im = el("img", "fill", card);
			im.src = img.src;
		} else mockUI(card, palette, accent, p.index);
		return (l, d) => {
			if (capG.length) riseGlyphs(capG, l, { at: 0.02, stagger: 0.022, rot: -6 });
			const e = expoOut(prog(l, 0.05, 0.85));
			const drift = Math.sin((l / d) * Math.PI) * 2;
			set(card, {
				opacity: clamp(l / 0.1).toFixed(3),
				transform: `translateY(${px((1 - e) * H * 0.35)}) rotateX(${lerp(28, 4, e).toFixed(3)}deg) rotateY(${(lerp(-18, -4, e) + drift).toFixed(3)}deg) scale(${lerp(0.9, 1, e).toFixed(4)})`,
			});
		};
	};

	SCENES.counter = ({ p, cam, fg, accent }) => {
		const s = p.scene;
		const wrap = el("div", "center", cam);
		const num = el("div", "display", wrap);
		set(num, { color: fg, fontVariantNumeric: "tabular-nums", lineHeight: "0.86", letterSpacing: "-0.06em" });
		const decimals = (String(s.value).split(".")[1] ?? "").length;
		const final = `${s.prefix ?? ""}${s.value.toFixed(decimals)}${s.suffix ?? ""}`;
		num.textContent = final;
		const size = fitLine(num, W * 0.8, H * 0.5, 520 * S);
		const label = el("div", "bold", wrap, s.label);
		set(label, { color: fg, fontSize: px(Math.max(34 * S, size * 0.17)), marginTop: px(size * 0.12), position: "relative", fontWeight: "700", letterSpacing: "-0.02em" });
		const bar = el("div", "", label);
		set(bar, { position: "absolute", left: "0", right: "0", bottom: "-0.28em", height: "0.16em", background: accent, transformOrigin: "0 50%", borderRadius: "0.08em" });
		const countDur = Math.min(1.2, p.dur * 0.7);
		return (l) => {
			const k = expoOut(prog(l, 0.04, countDur));
			const v = s.value === 0 ? lerp(99, 0, k) : lerp(0, s.value, k);
			num.textContent = `${s.prefix ?? ""}${v.toFixed(decimals)}${s.suffix ?? ""}`;
			const e = spring(l, 2.6, 0.55);
			set(num, { transform: `translateY(${px((1 - e) * 60 * S)}) scale(${(0.9 + 0.1 * e).toFixed(4)})`, opacity: clamp(l / 0.08).toFixed(3) });
			const lk = expoOut(prog(l, 0.25, 0.5));
			set(label, { opacity: lk.toFixed(3), transform: `translateY(${px((1 - lk) * 24 * S)})` });
			set(bar, { transform: `scaleX(${expoOut(prog(l, 0.45, 0.5)).toFixed(4)})` });
		};
	};

	SCENES.toggle = ({ p, cam, fg, accent }) => {
		const s = p.scene;
		const kind = s.kind ?? "switch";
		const vertical = H > W * 1.2;
		const wrap = el("div", "center", cam);
		set(wrap, { gap: px(60 * S) });
		const onAt = p.clickAt ?? p.dur * 0.42;
		const tw = Math.min(W * (vertical ? 0.62 : 0.34), H * 0.62);
		const holder = el("div", "", wrap);
		set(holder, { position: "relative", width: px(tw), height: px(kind === "checkbox" ? tw * 0.5 : tw * 0.5), display: "flex", alignItems: "center", justifyContent: "center" });
		const label = el("div", "bold", wrap);
		set(label, { color: fg });
		const labelG = glyphText(label, s.label).glyphs;
		fit(label, W * 0.8, H * 0.16, 130 * S);
		const off = alpha(fg, 0.16);
		const cursor = makeCursor(cam, 110 * S);
		let draw;
		let target = { x: W / 2, y: H / 2 };
		if (kind === "checkbox") {
			const b = tw * 0.42;
			const box = el("div", "", holder);
			set(box, { width: px(b), height: px(b), borderRadius: px(b * 0.24), boxSizing: "border-box", border: `${px(b * 0.08)} solid ${fg}` });
			box.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="${textOn(accent)}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="24" stroke-dashoffset="24"/></svg>`;
			const path = box.querySelector("path");
			draw = (l) => {
				const k = expoOut(prog(l, onAt, 0.35));
				set(box, { background: l >= onAt ? accent : "transparent", borderColor: l >= onAt ? accent : fg, transform: `scale(${(1 + 0.12 * Math.sin(prog(l, onAt, 0.3) * Math.PI)).toFixed(4)})` });
				path.setAttribute("stroke-dashoffset", String((1 - k) * 24));
			};
		} else if (kind === "slider") {
			const track = el("div", "", holder);
			const th = tw * 0.07;
			set(track, { position: "absolute", left: "0", right: "0", height: px(th), borderRadius: px(th), background: off });
			const fill = el("div", "", track);
			set(fill, { position: "absolute", left: "0", top: "0", bottom: "0", borderRadius: px(th), background: accent });
			const knob = el("div", "", holder);
			const kd = tw * 0.17;
			set(knob, { position: "absolute", width: px(kd), height: px(kd), borderRadius: "50%", background: "#fff", boxShadow: `0 ${px(8 * S)} ${px(20 * S)} rgba(0,0,0,0.25)`, top: px(tw * 0.25 - kd / 2) });
			draw = (l) => {
				const k = expoInOut(prog(l, onAt, 0.6));
				const x = lerp(0.12, 0.86, k);
				set(knob, { left: px(x * tw - kd / 2) });
				set(fill, { width: px(x * tw) });
			};
		} else {
			const th = tw * 0.5;
			const track = el("div", "", holder);
			set(track, { position: "absolute", inset: "0", borderRadius: px(th), background: off });
			const knob = el("div", "", holder);
			const kd = th * 0.82;
			set(knob, { position: "absolute", top: px((th - kd) / 2), width: px(kd), height: px(kd), borderRadius: px(kd), background: "#fff", boxShadow: `0 ${px(10 * S)} ${px(24 * S)} rgba(0,0,0,0.22)` });
			draw = (l) => {
				const k = spring(l - onAt, 2.6, 0.55);
				const move = Math.sin(clamp(prog(l, onAt, 0.25)) * Math.PI);
				const x = lerp((th - kd) / 2, tw - kd - (th - kd) / 2, k);
				set(knob, { left: px(x), width: px(kd * (1 + 0.28 * move)) });
				set(track, { background: l >= onAt + 0.04 ? accent : off });
			};
		}
		return (l) => {
			const e = spring(l, 2.4, 0.6);
			set(holder, { transform: `scale(${(0.7 + 0.3 * e).toFixed(4)})`, opacity: clamp(l / 0.08).toFixed(3) });
			riseGlyphs(labelG, l, { at: 0.1, stagger: 0.025, rot: -5 });
			draw(l);
			if (!target.set)
				target = { set: true, x: wrap.offsetLeft + holder.offsetLeft + holder.offsetWidth * (kind === "switch" ? 0.28 : 0.5), y: wrap.offsetTop + holder.offsetTop + holder.offsetHeight * 0.55 };
			cursor(l, { fx: target.x + 220 * S, fy: target.y + 260 * S, x: target.x, y: target.y, start: onAt - 0.5, arrive: onAt - 0.05, click: onAt, ringColor: alpha(fg, 0.6) });
		};
	};

	const logoNode = (parent, size, bg) => {
		const logo = plan.brand?.logo ? images[plan.brand.logo] : null;
		const n = el("div", "", parent);
		set(n, { width: px(size), height: px(size), borderRadius: px(size * 0.24), background: bg, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flex: "none" });
		if (logo) {
			const im = el("img", "", n);
			im.src = logo.src;
			set(im, { width: "78%", height: "78%", objectFit: "contain" });
		} else {
			const t = el("div", "display", n, (plan.brand?.name ?? "K").trim().charAt(0).toUpperCase());
			set(t, { fontSize: px(size * 0.62), color: textOn(bg), lineHeight: "1" });
		}
		return n;
	};

	SCENES.logo3d = ({ p, cam, fg, accent, palette }) => {
		const s = p.scene;
		const vertical = H > W * 1.2;
		const size = Math.min(W, H) * 0.32;
		const wrap = el("div", "center", cam);
		set(wrap, { flexDirection: vertical ? "column" : "row", gap: px(size * 0.28) });
		const scene3d = el("div", "", wrap);
		set(scene3d, { width: px(size), height: px(size), perspective: px(size * 4), flex: "none" });
		const cube = el("div", "", scene3d);
		set(cube, { position: "relative", width: "100%", height: "100%", transformStyle: "preserve-3d" });
		const brand = palette.brand;
		const faceColors = [brand, palette.brand2, palette.lime, palette.ink, accent, palette.peach];
		const rots = ["", "rotateY(90deg)", "rotateY(180deg)", "rotateY(-90deg)", "rotateX(90deg)", "rotateX(-90deg)"];
		const faces = rots.map((r, i) => {
			const f = el("div", "face", cube);
			set(f, { transform: `${r} translateZ(${px(size / 2)})`, background: faceColors[i], borderRadius: px(size * 0.06) });
			if (i === 0) {
				f.style.background = "transparent";
				const ln = logoNode(f, size, brand);
				set(ln, { borderRadius: px(size * 0.06) });
				f.__logo = ln;
			} else {
				const t = el("div", "display", f, (plan.brand?.name ?? "K").charAt(0).toUpperCase());
				set(t, { fontSize: px(size * 0.5), color: textOn(faceColors[i]) });
			}
			return f;
		});
		const name = el("div", "display", wrap);
		set(name, { color: fg });
		const nameG = glyphText(name, s.text ?? plan.brand?.name ?? "Kinetic").glyphs;
		fit(name, vertical ? W * 0.85 : W * 0.5, vertical ? H * 0.2 : H * 0.36, 260 * S);
		const spinEnd = Math.min(1.3, p.dur * 0.6);
		// The cube spins alone at the centre, then slides over as the name lands beside it.
		const gapPx = size * 0.28;
		const shift = ((vertical ? name.offsetHeight : name.offsetWidth) + gapPx) / 2;
		return (l) => {
			const slide = 1 - expoInOut(prog(l, spinEnd - 0.3, 0.55));
			set(wrap, { transform: vertical ? `translateY(${px(shift * slide)})` : `translateX(${px(shift * slide)})` });
			const k = expoOut(prog(l, 0, spinEnd));
			const e = spring(l, 2, 0.6);
			const ry = (1 - k) * 450 - 25 * (1 - k);
			const rx = (1 - k) * -160;
			set(cube, { transform: `translateZ(${px(-size / 2)}) rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg) scale(${(0.4 + 0.6 * e).toFixed(4)})` });
			const flat = expoOut(prog(l, spinEnd - 0.1, 0.4));
			faces.forEach((f, i) => {
				if (i === 0) {
					set(f.__logo, { borderRadius: px(size * lerp(0.06, 0.24, flat)) });
					return;
				}
				set(f, { opacity: (1 - flat).toFixed(3) });
			});
			riseGlyphs(nameG, l, { at: spinEnd - 0.25, stagger: 0.03 });
		};
	};

	SCENES.endcard = ({ p, cam, fg, accent }) => {
		const s = p.scene;
		const wrap = el("div", "center", cam);
		const size = Math.min(W, H) * 0.17;
		const logo = logoNode(wrap, size, plan.palette.brand);
		set(logo, { marginBottom: px(size * 0.32), boxShadow: `0 ${px(20 * S)} ${px(50 * S)} rgba(0,0,0,0.18)` });
		const name = el("div", "display", wrap);
		set(name, { color: fg });
		const g = glyphText(name, plan.brand?.name ?? "Kinetic").glyphs;
		fit(name, W * 0.82, H * 0.3, 300 * S);
		let tag = null;
		if (s.tagline) {
			tag = el("div", "bold", wrap, s.tagline);
			set(tag, { color: fg, fontSize: px(54 * S), fontWeight: "600", letterSpacing: "-0.025em", marginTop: px(30 * S), opacity: "0.8" });
		}
		const pill = el("div", "pill mono", wrap, s.cta);
		set(pill, { background: accent, color: textOn(accent), fontSize: px(46 * S), padding: `${px(22 * S)} ${px(48 * S)}`, marginTop: px(50 * S), letterSpacing: "0.06em", textTransform: "none" });
		const seeds = g.map((x) => ({ dx: hash(x.i * 3.3) * 2 - 1, dy: hash(x.i * 7.7) * 2 - 1, r: hash(x.i * 1.9) * 2 - 1, at: hash(x.i * 4.4) * 0.35 }));
		return (l) => {
			const le = spring(l, 2.4, 0.5);
			set(logo, { transform: `scale(${le.toFixed(4)}) rotate(${((1 - le) * -30).toFixed(3)}deg)` });
			g.forEach((x, i) => {
				const sd = seeds[i];
				const k = spring(l - 0.12 - sd.at, 2.6, 0.62);
				set(x.node, {
					opacity: clamp((l - 0.12 - sd.at) / 0.08).toFixed(3),
					transform: `translate(${((1 - k) * sd.dx * 1.6).toFixed(4)}em, ${((1 - k) * sd.dy * 1.2).toFixed(4)}em) rotate(${((1 - k) * sd.r * 70).toFixed(3)}deg) scale(${(0.5 + 0.5 * k).toFixed(4)})`,
				});
			});
			if (tag) {
				const k = expoOut(prog(l, 0.6, 0.5));
				set(tag, { opacity: (k * 0.8).toFixed(3), transform: `translateY(${px((1 - k) * 20 * S)})` });
			}
			const pk = spring(l - 0.75, 2.6, 0.55);
			set(pill, { opacity: clamp((l - 0.75) / 0.08).toFixed(3), transform: `translateY(${px((1 - pk) * 40 * S)}) scale(${(0.8 + 0.2 * pk).toFixed(4)})` });
		};
	};

	/** Stacked poster lines, each slamming in on its beat; the last one echoes. Crumbs decode around it. */
	SCENES.slam = ({ p, cam, fg, accent }) => {
		const s = p.scene;
		const marks = p.marks ?? s.lines.map((_, i) => i * p.beatLen);
		const wrap = el("div", "center", cam);
		const n = s.lines.length;
		const lines = s.lines.map((text, i) => {
			const node = el("div", "display", wrap);
			set(node, { color: i === n - 1 && n > 1 ? accent : fg, whiteSpace: "nowrap", position: "relative" });
			const g = glyphText(node, text).glyphs;
			fitLine(node, W * 0.88, (H * (n > 2 ? 0.8 : 0.68)) / n, 520 * S);
			return { node, g };
		});
		// Echoes of the last line, tinted, that slide apart once it lands.
		const last = lines[n - 1];
		const echoes = [1, 2].map((dir) => {
			const e = el("div", "display", last.node, s.lines[n - 1]);
			set(e, { position: "absolute", left: "0", top: "0", width: "100%", color: alpha(fg, dir === 1 ? 0.18 : 0.08), pointerEvents: "none", zIndex: "-1" });
			return { e, dir };
		});
		const spots = [[0.07, 0.2], [0.76, 0.14], [0.06, 0.8], [0.75, 0.84], [0.42, 0.07], [0.44, 0.92]];
		const crumbs = (s.crumbs ?? []).slice(0, 6).map((text, i) => {
			const c = el("div", "mono", cam);
			set(c, { position: "absolute", left: px(spots[i][0] * W), top: px(spots[i][1] * H), fontSize: px(24 * S), color: alpha(fg, 0.8), whiteSpace: "nowrap" });
			const g = glyphText(c, text).glyphs;
			return { g, at: 0.2 + i * Math.min(0.3, (p.dur * 0.7) / Math.max(1, s.crumbs.length)) };
		});
		return (l) => {
			let punch = 0;
			let pan = 0;
			lines.forEach(({ node, g }, i) => {
				riseGlyphs(g, l, { at: marks[i], stagger: 0.022, mode: "slam" });
				misreg(node, l > marks[i] ? 1 - prog(l, marks[i] + 0.06, 0.18) : 0);
				if (l > marks[i]) {
					const k = Math.exp(-(l - marks[i]) * 7);
					punch += 0.04 * k;
					pan += (i % 2 ? 1 : -1) * 26 * S * k;
				}
			});
			const lastAt = marks[n - 1] + 0.12;
			for (const { e, dir } of echoes) {
				const k = expoOut(prog(l, lastAt, 0.5));
				set(e, { opacity: k.toFixed(3), transform: `translateY(${(dir * k * 0.92).toFixed(4)}em)` });
			}
			for (const c of crumbs) riseGlyphs(c.g, l, { at: c.at, stagger: 0.02, mode: "scramble" });
			set(wrap, { transform: `translateX(${px(pan)}) scale(${(1 + punch).toFixed(4)})` });
		};
	};

	/** One shape, never cut: a UI element morphing state to state on the beat, driven by the cursor. */
	const MORPH = {
		button: { w: 520, h: 150, r: 75 },
		loader: { w: 150, h: 150, r: 75 },
		check: { w: 150, h: 150, r: 75 },
		toggle: { w: 300, h: 160, r: 80 },
		slider: { w: 780, h: 70, r: 35 },
		player: { w: 780, h: 210, r: 48 },
		tabs: { w: 780, h: 124, r: 62 },
		search: { w: 840, h: 134, r: 34 },
		toast: { w: 660, h: 134, r: 67 },
	};
	SCENES.morph = ({ p, cam, accent, bg }) => {
		const s = p.scene;
		const states = s.states;
		const marks = p.marks ?? states.map((_, i) => (i * p.dur) / states.length);
		const k = S * (W > H ? 1.25 : 1.05);
		const ink = lum(bg) > 0.4 ? "#111111" : "#f4f4f4";
		const onInk = textOn(ink);
		const solid = (st) => (st === "check" || st === "toggle" ? accent : st === "search" ? "#ffffff" : st === "slider" ? mixHex(bg, ink, 0.14) : ink);
		const shape = el("div", "", cam);
		set(shape, { position: "absolute", overflow: "hidden", boxShadow: `0 ${px(24 * S)} ${px(60 * S)} rgba(0,0,0,0.16)` });
		const layer = (st) => {
			const c = el("div", "", shape);
			set(c, { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", gap: px(24 * k), color: onInk, fontWeight: "650", letterSpacing: "-0.02em", whiteSpace: "nowrap" });
			const d = MORPH[st];
			const ctl = { c, st };
			if (st === "button") {
				c.textContent = s.label ?? "Generate";
				c.style.fontSize = px(54 * k);
			} else if (st === "loader") {
				c.innerHTML = `<svg viewBox="0 0 50 50" width="${(80 * k).toFixed(0)}" height="${(80 * k).toFixed(0)}"><circle cx="25" cy="25" r="19" fill="none" stroke="${alpha(onInk, 0.25)}" stroke-width="5"/><circle cx="25" cy="25" r="19" fill="none" stroke="${onInk}" stroke-width="5" stroke-linecap="round" stroke-dasharray="40 200"/></svg>`;
				ctl.spin = c.querySelector("svg");
			} else if (st === "check") {
				c.innerHTML = `<svg viewBox="0 0 24 24" width="${(84 * k).toFixed(0)}" height="${(84 * k).toFixed(0)}"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="${textOn(accent)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="24" stroke-dashoffset="24"/></svg>`;
				ctl.path = c.querySelector("path");
			} else if (st === "toggle") {
				const knob = el("div", "", c);
				set(knob, { position: "absolute", top: px(14 * k), width: px(132 * k), height: px(132 * k), borderRadius: "50%", background: "#fff", boxShadow: `0 ${px(6 * k)} ${px(14 * k)} rgba(0,0,0,0.2)` });
				ctl.knob = knob;
			} else if (st === "slider") {
				const fill = el("div", "", c);
				set(fill, { position: "absolute", left: "0", top: "0", bottom: "0", background: accent, borderRadius: px(35 * k) });
				const knob = el("div", "", shape);
				set(knob, { position: "absolute", top: px(-13 * k), width: px(96 * k), height: px(96 * k), borderRadius: "50%", background: "#fff", boxShadow: `0 ${px(8 * k)} ${px(20 * k)} rgba(0,0,0,0.25)` });
				ctl.fill = fill;
				ctl.knob = knob;
			} else if (st === "player") {
				set(c, { justifyContent: "flex-start", padding: `0 ${px(44 * k)}`, boxSizing: "border-box" });
				const btn = el("div", "", c);
				set(btn, { width: px(110 * k), height: px(110 * k), borderRadius: "50%", background: accent, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" });
				btn.innerHTML = `<svg viewBox="0 0 24 24" width="46%" height="46%"><path d="M7 5l12 7-12 7z" fill="${textOn(accent)}"/></svg>`;
				const col = el("div", "", c);
				set(col, { flex: "1", display: "flex", flexDirection: "column", gap: px(18 * k) });
				const t = el("div", "", col, plan.brand?.name ?? "Launch film");
				set(t, { fontSize: px(40 * k) });
				const bar = el("div", "", col);
				set(bar, { height: px(10 * k), borderRadius: px(5 * k), background: alpha(onInk, 0.2), position: "relative", overflow: "hidden" });
				const fillBar = el("div", "", bar);
				set(fillBar, { position: "absolute", left: "0", top: "0", bottom: "0", background: onInk, borderRadius: px(5 * k) });
				ctl.prog = fillBar;
			} else if (st === "tabs") {
				const ind = el("div", "", c);
				set(ind, { position: "absolute", top: px(14 * k), height: px(96 * k), borderRadius: px(48 * k), background: accent });
				const tabW = (d.w * k - 28 * k) / 3;
				["Write", "Edit", "Export"].forEach((name, i) => {
					const t = el("div", "", c, name);
					set(t, { position: "absolute", left: px(14 * k + i * tabW), width: px(tabW), textAlign: "center", fontSize: px(40 * k), zIndex: "1" });
				});
				ctl.ind = ind;
				ctl.tabW = tabW;
			} else if (st === "search") {
				set(c, { justifyContent: "flex-start", padding: `0 ${px(40 * k)}`, boxSizing: "border-box", color: "#15161a" });
				const kbd = el("div", "mono", c, "⌘K");
				set(kbd, { fontSize: px(30 * k), padding: `${px(8 * k)} ${px(14 * k)}`, borderRadius: px(10 * k), background: "#efeff2", color: "#50525c", letterSpacing: "0.04em" });
				const q = el("div", "", c);
				set(q, { fontSize: px(46 * k), fontWeight: "500" });
				ctl.q = q;
			} else if (st === "toast") {
				const dot = el("div", "", c);
				set(dot, { width: px(76 * k), height: px(76 * k), borderRadius: "50%", background: accent, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" });
				dot.innerHTML = `<svg viewBox="0 0 24 24" width="60%" height="60%"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="${textOn(accent)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
				const t = el("div", "", c, s.text ?? "Done");
				set(t, { fontSize: px(46 * k) });
			}
			return ctl;
		};
		const layers = states.map(layer);
		const cursor = makeCursor(cam, 84 * S);
		// Springs summed per target change keep every property a pure function of time.
		const chain = (get) => (l) => {
			let v = get(states[0]);
			for (let i = 1; i < states.length; i++) v += (get(states[i]) - get(states[i - 1])) * spring(l - marks[i], 3.1, 0.62);
			return v;
		};
		const wOf = chain((st) => MORPH[st].w * k);
		const hOf = chain((st) => MORPH[st].h * k);
		const rOf = chain((st) => MORPH[st].r * k);
		const cx = W / 2;
		const cy = H / 2;
		/** Where the cursor acts in a state, in stage coordinates (the shape is centred). */
		const actionPoint = (st) => {
			const d = MORPH[st];
			if (st === "toggle") return { x: cx - d.w * k * 0.22, y: cy };
			if (st === "slider") return { x: cx - d.w * k * 0.38, y: cy };
			if (st === "player") return { x: cx - d.w * k * 0.5 + 99 * k, y: cy };
			if (st === "tabs") return { x: cx + (d.w * k) / 3, y: cy };
			return { x: cx, y: cy };
		};
		const sliderValue = (l, i) => {
			const span = (i + 1 < states.length ? marks[i + 1] : p.dur) - marks[i];
			return lerp(0.12, 0.88, cubicInOut(prog(l - marks[i], span * 0.18, span * 0.55)));
		};
		return (l) => {
			const w = wOf(l);
			const h = hOf(l);
			const z = clamp(Math.min((W * 0.62) / Math.max(1, w), (H * 0.5) / Math.max(1, h)), 1, 1.9) * (1 + 0.02 * (l / p.dur));
			set(cam, { transform: `translate(${px((W * (1 - z)) / 2)}, ${px((H * (1 - z)) / 2)}) scale(${z.toFixed(4)})` });
			let cur = 0;
			for (let i = 0; i < states.length; i++) if (l >= marks[i]) cur = i;
			const col = cur === 0 ? solid(states[0]) : mixHex(solid(states[cur - 1]), solid(states[cur]), clamp((l - marks[cur]) / 0.18));
			set(shape, {
				left: px(cx - w / 2),
				top: px(cy - h / 2),
				width: px(Math.max(10, w)),
				height: px(Math.max(10, h)),
				borderRadius: px(Math.max(0, rOf(l))),
				background: col,
				overflow: states[cur] === "slider" ? "visible" : "hidden",
			});
			layers.forEach((ctl, i) => {
				const start = marks[i];
				const end = i + 1 < states.length ? marks[i + 1] : Infinity;
				const a = clamp((l - start - 0.08) / 0.12) * (1 - clamp((l - end + 0.02) / 0.08));
				set(ctl.c, { opacity: a.toFixed(3), filter: a < 0.99 ? `blur(${((1 - a) * 10 * S).toFixed(2)}px)` : "none", visibility: a > 0 ? "visible" : "hidden" });
				if (ctl.knob && ctl.st === "slider") set(ctl.knob, { visibility: a > 0 ? "visible" : "hidden", opacity: a.toFixed(3) });
				if (a <= 0) return;
				const local = l - start;
				const span = (end === Infinity ? p.dur : end) - start;
				if (ctl.spin) ctl.spin.style.transform = `rotate(${(local * 540).toFixed(1)}deg)`;
				if (ctl.path) ctl.path.setAttribute("stroke-dashoffset", String((1 - expoOut(prog(local, 0.08, 0.3))) * 24));
				if (ctl.st === "toggle") set(ctl.knob, { left: px(lerp(14 * k, MORPH.toggle.w * k - 146 * k, spring(local - span * 0.35, 3, 0.6))) });
				if (ctl.st === "slider") {
					const v = sliderValue(l, i);
					set(ctl.fill, { width: px(v * MORPH.slider.w * k) });
					set(ctl.knob, { left: px(v * MORPH.slider.w * k - 48 * k) });
				}
				if (ctl.prog) set(ctl.prog, { width: `${(prog(local, 0.1, span) * 100).toFixed(2)}%` });
				if (ctl.ind) set(ctl.ind, { left: px(14 * k + ctl.tabW * lerp(0, 2, spring(local - span * 0.25, 2.6, 0.7))), width: px(ctl.tabW) });
				if (ctl.q) {
					const q = s.text ?? "make it pop";
					ctl.q.textContent = q.slice(0, Math.round(clamp((local - 0.1) / Math.max(0.2, span * 0.6)) * q.length));
				}
			});
			// The cursor acts on the current state, then clicks into the next one on its beat.
			const next = cur + 1 < states.length ? cur + 1 : -1;
			const st = states[cur];
			const ap = actionPoint(st);
			if (st === "slider") {
				const x = cx - (MORPH.slider.w * k) / 2 + sliderValue(l, cur) * MORPH.slider.w * k;
				cursor(l, { fx: x, fy: cy, x, y: cy, start: marks[cur], arrive: marks[cur] + 0.01, click: marks[cur] + 0.15, ringColor: alpha(accent, 0.9) });
			} else if (next >= 0) {
				const from = cur > 0 ? actionPoint(states[cur - 1]) : { x: cx + 300 * S, y: cy + 260 * S };
				cursor(l, { fx: from.x, fy: from.y, x: ap.x, y: ap.y, start: marks[cur] + 0.05, arrive: marks[next] - 0.08, click: marks[next], ringColor: alpha(accent, 0.9) });
			} else cursor(l, { fx: ap.x, fy: ap.y, x: ap.x + 260 * S, y: ap.y + 240 * S, start: marks[cur] + 0.2, arrive: marks[cur] + 0.9, click: 1e9 });
		};
	};

	/** How it works: a ring fills in steps while numbered chips land on the beat. */
	SCENES.steps = ({ p, cam, fg, accent }) => {
		const s = p.scene;
		const n = s.steps.length;
		const marks = p.marks ?? s.steps.map((_, i) => 0.4 + i * p.beatLen);
		const vertical = H > W * 1.2;
		const wrap = el("div", "center", cam);
		let titleG = [];
		if (s.title) {
			const title = el("div", "display", wrap);
			set(title, { color: fg, marginBottom: px(56 * S) });
			titleG = glyphText(title, s.title).glyphs;
			fit(title, W * 0.8, H * 0.14, 130 * S);
		}
		const row = el("div", "", wrap);
		set(row, { display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: px(80 * S) });
		const d = Math.min(W, H) * (vertical ? 0.42 : 0.44);
		const ringBox = el("div", "", row);
		set(ringBox, { position: "relative", width: px(d), height: px(d), flex: "none" });
		const r = 44;
		const C = 2 * Math.PI * r;
		ringBox.innerHTML = `<svg viewBox="0 0 100 100" width="100%" height="100%" style="transform:rotate(-90deg)"><circle cx="50" cy="50" r="${r}" fill="none" stroke="${alpha(fg, 0.14)}" stroke-width="7"/><circle cx="50" cy="50" r="${r}" fill="none" stroke="${accent}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}"/></svg>`;
		const arc = ringBox.querySelectorAll("circle")[1];
		const pct = el("div", "display", ringBox, "0%");
		set(pct, { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", color: fg, fontSize: px(d * 0.26), fontVariantNumeric: "tabular-nums" });
		const list = el("div", "", row);
		set(list, { display: "flex", flexDirection: "column", gap: px(22 * S) });
		const chips = s.steps.map((text, i) => {
			const c = el("div", "", list);
			set(c, { display: "flex", alignItems: "center", gap: px(26 * S), padding: `${px(18 * S)} ${px(34 * S)} ${px(18 * S)} ${px(18 * S)}`, borderRadius: px(999), background: alpha(fg, 0.07), color: fg });
			const num = el("div", "mono", c, String(i + 1).padStart(2, "0"));
			set(num, { width: px(66 * S), height: px(66 * S), borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: px(24 * S), letterSpacing: "0.02em", border: `${px(2.5 * S)} solid ${alpha(fg, 0.3)}`, flex: "none", boxSizing: "border-box" });
			const t = el("div", "bold", c, text);
			set(t, { fontSize: px((vertical ? 50 : 56) * S), whiteSpace: "nowrap" });
			return { c, num };
		});
		return (l) => {
			if (titleG.length) riseGlyphs(titleG, l, { at: 0.02, stagger: 0.025, rot: -5 });
			let v = 0;
			for (let i = 0; i < n; i++) v += (1 / n) * spring(l - marks[i], 2.6, 0.75);
			arc.setAttribute("stroke-dashoffset", (C * (1 - clamp(v))).toFixed(2));
			pct.textContent = `${Math.round(clamp(v) * 100)}%`;
			const e = spring(l, 2.4, 0.7);
			set(ringBox, { transform: `scale(${(0.7 + 0.3 * e).toFixed(4)}) rotate(${((1 - e) * -40).toFixed(2)}deg)`, opacity: clamp(l / 0.1).toFixed(3) });
			chips.forEach(({ c, num }, i) => {
				const k = spring(l - marks[i] + 0.12, 3, 0.62);
				set(c, { opacity: clamp((l - marks[i] + 0.12) / 0.08).toFixed(3), transform: `translateX(${px((1 - k) * 90 * S)}) scale(${(0.92 + 0.08 * k).toFixed(4)})` });
				const done = l >= marks[i];
				set(num, { background: done ? accent : "transparent", color: done ? textOn(accent) : fg, borderColor: done ? accent : alpha(fg, 0.3) });
			});
		};
	};

	/** A ticket card types its rows, then a stamp presses down on the beat. */
	SCENES.ticket = ({ p, cam, accent, bg }) => {
		const s = p.scene;
		const at = p.marks?.[0] ?? p.dur * 0.66;
		const vertical = H > W * 1.2;
		const tw = vertical ? W * 0.84 : Math.min(W * 0.56, 1000 * S);
		const card = el("div", "ticket", cam);
		const ink = textOn(accent);
		set(card, { width: px(tw), left: px((W - tw) / 2), background: accent, color: ink, borderRadius: px(30 * S), padding: px(56 * S), gap: px(26 * S), boxShadow: `0 ${px(40 * S)} ${px(90 * S)} rgba(0,0,0,0.22)` });
		const head = el("div", "display", card, s.title);
		set(head, { color: ink });
		fitLine(head, tw - 112 * S, 120 * S, 110 * S);
		const rule = el("div", "", card);
		set(rule, { borderTop: `${px(3 * S)} dashed ${alpha(ink, 0.45)}`, margin: `${px(6 * S)} 0` });
		const rows = s.rows.map(([k, v]) => {
			const r = el("div", "", card);
			set(r, { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: px(30 * S) });
			const lab = el("div", "mono", r, k);
			set(lab, { fontSize: px(26 * S), opacity: "0.7" });
			const val = el("div", "bold", r, "");
			set(val, { fontSize: px(52 * S), whiteSpace: "nowrap", minHeight: "1em" });
			return { val, text: v };
		});
		// Perforation: two notches cut in the scene's colour.
		for (const side of ["left", "right"]) {
			const notch = el("div", "", card);
			set(notch, { position: "absolute", top: px(150 * S), [side]: px(-26 * S), width: px(52 * S), height: px(52 * S), borderRadius: "50%", background: bg });
		}
		const stampCol = lum(accent) > 0.4 ? "#111111" : "#ffffff";
		const stamp = el("div", "stamp", cam, s.stamp);
		set(stamp, { color: stampCol, border: `${px(10 * S)} solid ${stampCol}`, borderRadius: px(22 * S), fontSize: px(96 * S), padding: `${px(10 * S)} ${px(40 * S)}` });
		const ch = card.offsetHeight;
		const sw = stamp.offsetWidth;
		const sh = stamp.offsetHeight;
		return (l) => {
			const top = (H - ch) / 2;
			const e = spring(l, 2.2, 0.62);
			const jolt = l >= at ? Math.exp(-(l - at) * 12) : 0;
			set(card, { top: px(top), transform: `translateY(${px((1 - e) * -H * 0.9)}) rotate(${((1 - e) * 8 - 1.5 + jolt * 1.2).toFixed(3)}deg) scale(${(1 - 0.025 * jolt).toFixed(4)})` });
			const span = Math.max(0.3, at - 0.55);
			rows.forEach((r, i) => {
				const from = 0.45 + (i * span) / rows.length;
				const nChars = Math.round(clamp((l - from) / Math.max(0.1, span / rows.length - 0.05)) * r.text.length);
				r.val.textContent = r.text.slice(0, nChars);
			});
			const sk = expoOut(prog(l, at - 0.07, 0.1));
			set(stamp, {
				left: px(W / 2 + tw * 0.08 - sw / 2),
				top: px(top + ch * 0.62 - sh / 2),
				opacity: l >= at - 0.07 ? "0.92" : "0",
				transform: `rotate(-11deg) scale(${lerp(2.4, 1, sk).toFixed(4)})`,
			});
		};
	};

	/** Ticker bands across the frame, sliding in opposite directions, never stopping. */
	SCENES.marquee = ({ p, cam, fg, accent, palette, bg }) => {
		const s = p.scene;
		const bands = [
			{ rot: -7, y: 0.22, dir: -1, bg: accent },
			{ rot: 4, y: 0.5, dir: 1, bg: fg },
			{ rot: -3, y: 0.78, dir: -1, bg: lum(bg) > 0.5 ? palette.ink : palette.paper },
		];
		const bh = H * 0.21;
		const items = bands.map((b, i) => {
			const band = el("div", "", cam);
			const text = Array.from({ length: 8 }, (_, j) => s.words[(j + i * 2) % s.words.length]).join("  ✳  ");
			set(band, { position: "absolute", left: px(-W * 0.3), width: px(W * 1.6), height: px(bh), top: px(b.y * H - bh / 2), background: b.bg, overflow: "hidden", display: "flex", alignItems: "center" });
			const t = el("div", "display", band, `${text}  ✳  ${text}`);
			set(t, { color: textOn(b.bg), fontSize: px(bh * 0.62), whiteSpace: "nowrap", lineHeight: "1" });
			return { band, t, b };
		});
		return (l) => {
			items.forEach(({ band, t, b }, i) => {
				const k = expoOut(prog(l, i * 0.07, 0.6));
				set(band, { transform: `rotate(${b.rot}deg) translateX(${px((1 - k) * b.dir * -W * 1.2)})` });
				set(t, { transform: `translateX(${px(-W * 0.4 + b.dir * l * 260 * S)})` });
			});
		};
	};

	/** Three phones fan out from a stack, each showing a screen. */
	SCENES.phones = ({ p, cam, fg, palette }) => {
		const s = p.scene;
		const imgs = (s.images ?? []).map((u) => images[u]).filter(Boolean);
		const vertical = H > W * 1.2;
		let capG = [];
		if (s.caption) {
			const cap = el("div", "display", cam);
			set(cap, { position: "absolute", left: "0", right: "0", top: px(H * 0.07), textAlign: "center", color: fg, margin: "0 auto" });
			capG = glyphText(cap, s.caption).glyphs;
			fit(cap, W * 0.86, H * (vertical ? 0.12 : 0.15), 140 * S);
		}
		const ph = H * (vertical ? 0.5 : s.caption ? 0.66 : 0.78);
		const pw = ph / 2.05;
		const top = s.caption ? H * (vertical ? 0.3 : 0.27) : (H - ph) / 2;
		const phones = [0, 1, 2].map((i) => {
			const ph0 = el("div", "phone", cam);
			set(ph0, { width: px(pw), height: px(ph), left: px(W / 2 - pw / 2), top: px(top), borderRadius: px(pw * 0.16), zIndex: i === 1 ? "3" : "2", boxShadow: `0 ${px(40 * S)} ${px(80 * S)} rgba(0,0,0,0.3)` });
			const scr = el("div", "screen", ph0);
			const inset = pw * 0.035;
			set(scr, { left: px(inset), top: px(inset), right: px(inset), bottom: px(inset), borderRadius: px(pw * 0.13) });
			const img = imgs.length ? imgs[(i + 1) % imgs.length] : null;
			if (img) {
				const im = el("img", "fill", scr);
				im.src = img.src;
			} else {
				// The product's own screens, phone-sized: a list, the dashboard and a chat.
				set(scr, { overflow: "hidden", paddingTop: px(pw * 0.12), boxSizing: "border-box", background: lum(palette.paper) < 0.2 ? "#0d0f15" : "#ffffff" });
				const inner = el("div", "", scr);
				set(inner, { position: "relative", width: "100%", height: "100%" });
				mockUI(inner, palette, palette.electric, i, ["inbox", "dashboard", "chat"][i]);
			}
			const island = el("div", "", ph0);
			set(island, { position: "absolute", top: px(pw * 0.06), left: px(pw * 0.36), width: px(pw * 0.28), height: px(pw * 0.08), borderRadius: px(99), background: "#0b0b0d" });
			return ph0;
		});
		const spread = [-1, 0, 1];
		return (l, d) => {
			if (capG.length) riseGlyphs(capG, l, { at: 0.02, stagger: 0.022, rot: -6 });
			phones.forEach((ph0, i) => {
				const k = spring(l - 0.15 - Math.abs(spread[i]) * 0.08, 2.2, 0.7);
				const rise = expoOut(prog(l, 0, 0.6));
				const float = Math.sin((l / d) * Math.PI * 2 + i) * 8 * S;
				set(ph0, {
					transform: `translate(${px(spread[i] * k * pw * 1.08)}, ${px((1 - rise) * H * 0.6 + Math.abs(spread[i]) * k * ph * 0.05 + float)}) rotate(${(spread[i] * k * 8).toFixed(3)}deg)`,
				});
			});
		};
	};

	/** Scenes that drive their own camera. */
	const SELF_CAMERA = new Set(["prompt", "ui-macro", "morph", "laptop", "browser", "dock"]);

	/** The helper kit handed to scene modules (scenes/*.js register on window.KineticScenes). */
	const kit = () => ({
		W, H, S, plan, images, stage,
		clamp, lerp, prog, expoOut, expoIn, expoInOut, cubicInOut, quartOut, spring, hash, lum, textOn, alpha, mixHex,
		el, set, px, fit, fitLine, glyphText, plain, riseGlyphs, misreg, makeCursor, mockUI, logoNode,
		CURSOR_SVG,
	});

	// ---------- build ----------
	let ready = false;
	/** The film's own style; a scene with its own (ps.look) swaps it in while it builds and draws. */
	let base = null;
	let boil = null;
	const useScene = (ps) => {
		curPS = ps;
		if (!base) return;
		plan.look = ps?.look ?? base.look;
		plan.palette = ps?.palette ?? base.palette;
		M = ps?.M ?? base.M;
	};
	const build = async (nextPlan, nextOpts = {}) => {
		ready = false;
		plan = nextPlan;
		const mo = plan.motion ?? {};
		// The style's own feel, scaled by the user's motion settings.
		const feelM = (look) => {
			const fe = look?.feel ?? {};
			return { snap: (mo.snap ?? 1) * (fe.snap ?? 1), bounce: (mo.bounce ?? 1) * (fe.bounce ?? 1), curve: Array.isArray(mo.curve) && mo.curve.length === 4 ? bezier(mo.curve) : null, camera: fe.camera ?? "push" };
		};
		M = feelM(plan.look);
		base = { look: plan.look, palette: plan.palette, M };
		for (const ps of plan.scenes) if (ps.look) ps.M = feelM(ps.look);
		opts = nextOpts;
		W = plan.width;
		H = plan.height;
		S = Math.min(W, H) / 1080;
		stage.innerHTML = "";
		filters.innerHTML = "";
		set(stage, { width: px(W), height: px(H), filter: plan.look?.post?.grade ?? "none" });
		stage.__s = {};
		stage.style.width = px(W);
		stage.style.height = px(H);
		layout();
		const type = plan.look?.display;
		if (type) {
			stage.style.setProperty("--fd", type.family);
			stage.style.setProperty("--fw", String(type.weight));
			stage.style.setProperty("--fb", String(Math.min(type.weight, 820)));
			stage.style.setProperty("--fst", `${type.stretch}%`);
			stage.style.setProperty("--ft", `${type.tracking}em`);
			stage.style.setProperty("--flh", String(type.lineHeight));
			stage.style.setProperty("--fcase", type.upper ? "uppercase" : "none");
		}
		await document.fonts.load('900 100px "Archivo"');
		await document.fonts.load('italic 400 100px "Instrument Serif"');
		await document.fonts.load('900 100px "Geist"');
		await document.fonts.load('500 100px "Geist Mono"');
		await document.fonts.ready;
		const urls = new Set();
		if (plan.brand?.logo) urls.add(plan.brand.logo);
		for (const ps of plan.scenes) {
			if (ps.scene.image) urls.add(ps.scene.image);
			for (const u of ps.scene.images ?? []) urls.add(u);
		}
		images = {};
		await Promise.all(
			[...urls].map(async (u) => {
				const r = await loadImage(u);
				if (r) images[u] = r;
			}),
		);
		boil = null;
		if ([plan.look, ...plan.scenes.map((x) => x.look)].some((l) => l?.deco?.sketch)) {
			const f = document.createElementNS("http://www.w3.org/2000/svg", "filter");
			f.setAttribute("id", "boil");
			const turb = document.createElementNS("http://www.w3.org/2000/svg", "feTurbulence");
			turb.setAttribute("type", "fractalNoise");
			turb.setAttribute("baseFrequency", "0.018");
			turb.setAttribute("numOctaves", "2");
			const disp = document.createElementNS("http://www.w3.org/2000/svg", "feDisplacementMap");
			disp.setAttribute("in", "SourceGraphic");
			disp.setAttribute("scale", String(Math.round(5 * S)));
			f.append(turb, disp);
			filters.appendChild(f);
			boil = turb;
		}
		built = plan.scenes.map((ps) => {
			useScene(ps);
			const root = el("div", "scene", stage);
			root.classList.add(`look-${(ps.look ?? plan.look)?.id ?? "editorial"}`);
			const dt = ps.look?.display;
			if (dt) {
				// The scene's own type, through the same custom properties the stage sets.
				root.style.setProperty("--fd", dt.family);
				root.style.setProperty("--fw", String(dt.weight));
				root.style.setProperty("--fb", String(Math.min(dt.weight, 820)));
				root.style.setProperty("--fst", `${dt.stretch}%`);
				root.style.setProperty("--ft", `${dt.tracking}em`);
				root.style.setProperty("--flh", String(dt.lineHeight));
				root.style.setProperty("--fcase", dt.upper ? "uppercase" : "none");
			}
			root.style.zIndex = String(10 + ps.index);
			// Post: bloom glows the type in the scene's own colours; aberration splits it into RGB.
			const post = plan.look?.post ?? {};
			if (post.bloom) {
				root.classList.add("fx-bloom");
				root.style.setProperty("--bloom", String(post.bloom));
				root.style.setProperty("--glow-fg", alpha(ps.fg, 0.55));
				root.style.setProperty("--glow", alpha(ps.accent, 0.6));
				root.style.setProperty("--glow-soft", alpha(ps.accent, 0.28));
			}
			if (post.aberration) root.classList.add("fx-ab");
			if (plan.look?.deco?.chrome) root.classList.add("fx-chrome");
			const sky = paintBg(root, ps.bg, ps.index);
			const decoDraw = decorate(root, ps);
			const cam = el("div", "cam", root);
			if (base.look?.deco?.letterbox) {
				// Keep everything inside the scope: the camera's frame shrinks to the area between the
				// bars (the individual scale/translate properties compose with any camera transform).
				const k = 1 - (2 * letterboxBar()) / H;
				set(cam, { scale: k.toFixed(4), translate: `${px((W * (1 - k)) / 2)} ${px((H * (1 - k)) / 2)}` });
			}
			const f = document.createElementNS("http://www.w3.org/2000/svg", "filter");
			f.setAttribute("id", `mb${ps.index}`);
			f.setAttribute("x", "-20%");
			f.setAttribute("width", "140%");
			const blur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
			blur.setAttribute("stdDeviation", "0 0");
			f.appendChild(blur);
			filters.appendChild(f);
			const builder = SCENES[ps.scene.type] ?? window.KineticScenes?.[ps.scene.type] ?? SCENES.title;
			const palette = plan.palette;
			const bgHex = ps.bg === "sky" ? palette.sky : ps.bg;
			let draw = () => {};
			try {
				// Scenes see their own clock: pace-warped length and beat.
				draw = builder({ p: { ...ps, dur: ps.ldur ?? ps.dur, beatLen: plan.beat * (ps.speed ?? 1) }, root, cam, fg: ps.fg, accent: ps.accent, palette, bg: bgHex, K: kit() });
			} catch (err) {
				console.error("scene build failed", ps.scene.type, err);
			}
			return { ps, root, cam, draw, sky: (l) => (sky(l), decoDraw(l)), blur, lastVisible: false, ab: post.aberration ?? 0 };
		});
		useScene(null);
		grain = null;
		if (plan.grain) {
			grain = el("div", "", stage);
			grain.id = "grain";
			set(grain, { backgroundImage: `url(${noiseTile()})`, opacity: String(plan.look?.deco?.grain ?? 0.11) });
		}
		buildOverlays();
		wipebar = el("div", "", stage);
		wipebar.id = "wipebar";
		if (opts.watermark) {
			// Free exports carry a small pill with the site, so every shared film says where it came from.
			const wm = el("div", "", stage);
			wm.id = "watermark";
			const mk = el("span", "", wm, "K");
			el("span", "", wm, "Made with Kinetic · kinetic.launchloop.tech");
			set(wm, { right: px(24 * S), bottom: px(22 * S), fontSize: px(22 * S), padding: `${px(9 * S)} ${px(16 * S)} ${px(9 * S)} ${px(9 * S)}`, gap: px(10 * S), borderRadius: px(999) });
			set(mk, { width: px(30 * S), height: px(30 * S), borderRadius: px(8 * S), fontSize: px(18 * S) });
		}
		ready = true;
		draw(0);
	};

	/** Fit the stage into the window (preview); export windows are exactly W x H. */
	const layout = () => {
		const k = Math.min(window.innerWidth / W, window.innerHeight / H);
		stage.style.transform = `scale(${k})`;
		stage.style.margin = `${((H * k - H) / 2).toFixed(1)}px ${((W * k - W) / 2).toFixed(1)}px`;
	};
	window.addEventListener("resize", () => plan && layout());

	const resetRoot = (b) => {
		set(b.root, { transform: "none", clipPath: "none", filter: "none", opacity: "1", maskImage: "none", webkitMaskImage: "none" });
	};

	const draw = (t) => {
		if (!plan || !ready) return;
		const n = built.length;
		for (let i = 0; i < n; i++) {
			const b = built[i];
			const { start, dur } = b.ps;
			const inTr = b.ps.trDur;
			const outTr = i + 1 < n ? built[i + 1].ps.trDur : 0;
			const visible = (t >= start - inTr / 2 || i === 0) && (t < start + dur + outTr / 2 || i === n - 1);
			if (visible !== b.lastVisible) {
				b.root.style.visibility = visible ? "visible" : "hidden";
				b.lastVisible = visible;
			}
			if (!visible) continue;
			resetRoot(b);
			useScene(b.ps);
			const l = t - start;
			// Camera life: it never stops. A steady push, a punch-in on hard cuts, and a small
			// kick on every beat so something always moves with the music.
			const punch = b.ps.transition === "cut" && i > 0 ? 0.05 * (1 - expoOut(prog(l, 0, 0.3))) : 0;
			const kick = 0.01 * Math.exp(-((t + 1e-6) % plan.beat) * 9);
			const type = b.ps.scene.type;
			if (!SELF_CAMERA.has(type)) set(b.cam, { transform: camera(M.camera, l, dur, t, punch, kick, i) });
			// Chromatic aberration rests a little split and jumps on every beat.
			if (b.ab) b.root.style.setProperty("--ab", (b.ab * S * (1.5 + 7 * Math.exp(-((t + 1e-6) % plan.beat) * 10))).toFixed(2));
			const sp = b.ps.speed ?? 1;
			b.sky(l);
			try {
				b.draw(Math.max(0, l * sp), dur * sp);
			} catch (err) {
				if (!b.failed) console.error("scene draw failed", b.ps.scene.type, err?.stack ?? err);
				b.failed = true;
			}
			b.blur.setAttribute("stdDeviation", "0 0");
		}
		useScene(null);
		wipebar.style.visibility = "hidden";
		if (wipebar.style.maskImage && wipebar.style.maskImage !== "none") set(wipebar, { maskImage: "none", webkitMaskImage: "none" });
		set(wipebar, { opacity: "1" });
		set(stage, { background: "" });
		// Transitions between neighbours.
		for (let i = 1; i < n; i++) {
			const b = built[i];
			const a = built[i - 1];
			const tr = b.ps.trDur;
			if (!tr) continue;
			const t0 = b.ps.start - tr / 2;
			if (t < t0 || t > t0 + tr) continue;
			const p = (t - t0) / tr;
			applyTransition(b.ps.transition, a, b, M.curve ? M.curve(p) : p);
		}
		if (overlays.length) {
			const cur = built.find((b) => t >= b.ps.start && t < b.ps.start + b.ps.dur) ?? built[built.length - 1];
			for (const o of overlays) o(t, cur.ps);
		}
		// Hand-drawn boil: a new noise seed 8 times a second, like redrawn animation frames.
		if (boil) boil.setAttribute("seed", String(Math.floor(t * 8) % 97));
		if (grain) {
			const f = Math.floor(t * 24);
			set(grain, { transform: `translate(${px((hash(f) - 0.5) * 200)}, ${px((hash(f + 0.5) - 0.5) * 200)})` });
		}
	};

	/** Each style's camera: how the frame lives while a scene plays. l = scene time, t = film time. */
	const camera = (kind, l, dur, t, punch, kick, i) => {
		const u = clamp(l / dur);
		const beatPhase = (t + 1e-6) % plan.beat;
		const beatN = Math.floor((t + 1e-6) / plan.beat);
		let z = 1, x = 0, y = 0, r = 0, extra = "";
		if (kind === "punch") {
			// Poster: every scene slams in from a tight crop, a hard kick on each beat.
			z = 1 + 0.14 * (1 - expoOut(prog(l, 0, 0.35))) + 0.03 * Math.exp(-beatPhase * 12);
		} else if (kind === "settle") {
			// Keynote: starts close and slowly settles back, like a stage camera.
			z = 1.1 - 0.1 * expoOut(prog(l, 0, Math.min(dur, 2.4)));
			y = -H * 0.012 * (1 - u);
		} else if (kind === "pan") {
			// Blueprint / Swiss: a precise, linear dolly sideways, alternating direction.
			z = 1.04;
			x = W * 0.025 * (i % 2 ? 1 : -1) * (u - 0.5);
		} else if (kind === "shake") {
			// Loud: big beat kicks with a jolt in a random direction.
			const k = Math.exp(-beatPhase * 10);
			z = 1.02 + 0.045 * k + punch;
			x = (hash(beatN) - 0.5) * W * 0.02 * k;
			y = (hash(beatN + 0.37) - 0.5) * H * 0.02 * k;
			r = (hash(beatN + 0.71) - 0.5) * 1.6 * k;
		} else if (kind === "glitch") {
			// Terminal: hard, stepped jumps a few times a scene, otherwise dead still.
			const step = Math.floor(l * 6);
			const on = hash(step + i * 13) > 0.86;
			z = 1 + (on ? 0.03 : 0);
			x = on ? (hash(step + 0.5) - 0.5) * W * 0.03 : 0;
		} else if (kind === "handheld") {
			// Riso / Halftone: a gentle wander, like a camera held by hand.
			z = 1.035 + 0.02 * u + kick;
			x = W * 0.008 * Math.sin(t * 1.3) + W * 0.004 * Math.sin(t * 3.1);
			y = H * 0.008 * Math.cos(t * 1.1) + H * 0.003 * Math.sin(t * 2.7);
			r = 0.5 * Math.sin(t * 0.9);
		} else if (kind === "float") {
			// Glass: the whole frame floats and tilts in 3D.
			z = 1.03 + 0.02 * u;
			y = H * 0.01 * Math.sin(t * 1.4);
			extra = ` perspective(${px(2600 * S)}) rotateX(${(2.2 * Math.sin(t * 0.8)).toFixed(3)}deg) rotateY(${(3 * Math.cos(t * 0.6)).toFixed(3)}deg)`;
		} else if (kind === "onetake") {
			// One take: the camera keeps travelling in one direction for the whole film, so scenes
			// read as one continuous shot. Film time drives it, not scene time.
			z = 1.08 + 0.03 * Math.sin(t * 0.45);
			x = -W * 0.035 * Math.sin(t * 0.32);
			y = -H * 0.02 * Math.cos(t * 0.27);
			r = 0.6 * Math.sin(t * 0.21);
		} else if (kind === "orbit") {
			// Neon / Chrome: a 3D orbit around the subject, sweeping side to side, kicking in on the beat.
			const sw = cubicInOut(u) * 2 - 1;
			z = 0.97 + 0.02 * Math.exp(-beatPhase * 9) + punch;
			y = H * 0.006 * Math.sin(t * 1.1);
			extra = ` perspective(${px(3000 * S)}) rotateY(${(sw * 3.2 * (i % 2 ? -1 : 1)).toFixed(3)}deg) rotateX(${(1.4 * Math.sin(t * 0.7)).toFixed(3)}deg)`;
		} else if (kind === "dolly") {
			// Cinematic: a slow, steady dolly in with a faint drift, like a camera on rails.
			z = 1.02 + 0.075 * cubicInOut(u);
			x = W * 0.006 * Math.sin(t * 0.35 + i);
			y = H * 0.008 * (0.5 - u);
		} else if (kind === "still") {
			// Minimal / Mono: no camera at all; the design does the moving.
			z = 1;
		} else {
			z = 1 + 0.055 * u + punch + kick;
		}
		return `translate(${px((W * (1 - z)) / 2 + x)}, ${px((H * (1 - z)) / 2 + y)}) scale(${z.toFixed(4)}) rotate(${r.toFixed(3)}deg)${extra}`;
	};

	const applyTransition = (kind, a, b, p) => {
		const blurAmt = (v, node) => node.setAttribute("stdDeviation", `${v.toFixed(2)} 0`);
		if (kind === "whip") {
			const e = expoInOut(p);
			const bl = Math.sin(p * Math.PI) * 70 * S;
			set(a.root, { transform: `translateX(${px(-e * W)})`, filter: `url(#mb${a.ps.index})` });
			set(b.root, { transform: `translateX(${px((1 - e) * W)})`, filter: `url(#mb${b.ps.index})` });
			blurAmt(bl, a.blur);
			blurAmt(bl, b.blur);
		} else if (kind === "push") {
			const e = expoInOut(p);
			set(a.root, { transform: `translateY(${px(-e * H * 0.35)}) scale(${(1 - 0.08 * e).toFixed(4)})`, opacity: (1 - e * 0.5).toFixed(3) });
			set(b.root, { transform: `translateY(${px((1 - e) * H)})` });
		} else if (kind === "circle") {
			const e = expoInOut(p);
			const r = Math.hypot(W, H) * e * 0.6;
			const fc = a.focus ?? { x: W / 2, y: H / 2 };
			set(b.root, { clipPath: `circle(${px(r)} at ${px(fc.x)} ${px(fc.y)})` });
			set(a.root, { transform: `scale(${(1 + 0.08 * e).toFixed(4)})` });
		} else if (kind === "zoom") {
			const ei = expoIn(clamp(p * 1.25));
			const eo = expoOut(clamp((p - 0.35) / 0.65));
			set(a.root, { transform: `scale(${(1 + 3.2 * ei).toFixed(4)})`, opacity: (1 - clamp((p - 0.3) / 0.4)).toFixed(3) });
			set(b.root, { transform: `scale(${(0.55 + 0.45 * eo).toFixed(4)})`, opacity: clamp((p - 0.3) / 0.35).toFixed(3) });
		} else if (kind === "glide") {
			const e = cubicInOut(p);
			set(a.root, { transform: `translateX(${px(-e * W)})` });
			set(b.root, { transform: `translateX(${px((1 - e) * W)})` });
		} else if (kind === "scan") {
			const e = cubicInOut(p);
			const y = e * H;
			set(b.root, { clipPath: `inset(0 0 ${px(H - y)} 0)` });
			wipebar.style.visibility = "visible";
			const line = 5 * S;
			set(wipebar, { background: b.ps.accent, clipPath: `inset(${px(Math.max(0, y - line))} 0 ${px(Math.max(0, H - y - line))} 0)` });
		} else if (kind === "iris") {
			// A six-blade camera aperture opening on the next scene, turning as it opens, with an
			// accent ring riding the edge.
			const e = expoInOut(p);
			const R = Math.hypot(W, H) * 0.62 * e;
			const ring = 26 * S * Math.sin(p * Math.PI);
			const rot = (1 - e) * 70;
			const fc = a.focus ?? { x: W / 2, y: H / 2 };
			const hex = (r) =>
				Array.from({ length: 6 }, (_, i) => {
					const ang = ((rot + i * 60) * Math.PI) / 180;
					return `${px(fc.x + Math.cos(ang) * r)} ${px(fc.y + Math.sin(ang) * r)}`;
				}).join(", ");
			set(b.root, { clipPath: `polygon(${hex(R)})` });
			set(a.root, { transform: `scale(${(1 + 0.1 * e).toFixed(4)}) rotate(${(e * -4).toFixed(3)}deg)` });
			if (ring > 0.5) {
				wipebar.style.visibility = "visible";
				set(wipebar, { background: b.ps.accent, clipPath: `polygon(evenodd, ${hex(R + ring)}, ${hex(Math.max(0, R))})` });
			}
		} else if (kind === "flood") {
			// Colour floods up from the bottom with a sloshing wave edge; the next scene rides behind it.
			const e = cubicInOut(p);
			const band = H * 0.16;
			const lvl = lerp(H + band + 40 * S, -band - 40 * S, e);
			const amp = 38 * S * Math.sin(p * Math.PI);
			const wave = (y0) => {
				const pts = [];
				for (let i = 0; i <= 24; i++) {
					const x = (i / 24) * W;
					pts.push(`${px(x)} ${px(y0 + Math.sin(i * 0.7 + p * 9) * amp)}`);
				}
				return pts;
			};
			const front = wave(lvl);
			const back = wave(lvl + band);
			set(b.root, { clipPath: `polygon(${back.join(", ")}, ${px(W)} ${px(H)}, 0 ${px(H)})` });
			wipebar.style.visibility = "visible";
			set(wipebar, { background: b.ps.accent, clipPath: `polygon(${front.join(", ")}, ${back.slice().reverse().join(", ")})` });
			set(a.root, { transform: `translateY(${px(-e * H * 0.08)})` });
		} else if (kind === "halftone") {
			// The next scene arrives through print dots that grow until they merge; accent dots lead.
			const cell = 44 * S;
			const r = (k) => `radial-gradient(circle at center, #000 ${(clamp(k) * 72).toFixed(2)}%, transparent ${(clamp(k) * 72 + 1).toFixed(2)}%)`;
			const k = cubicInOut(p);
			const size = `${px(cell)} ${px(cell)}`;
			set(b.root, { maskImage: r(k), webkitMaskImage: r(k), maskSize: size, webkitMaskSize: size, maskPosition: "center", webkitMaskPosition: "center" });
			if (p < 0.9) {
				wipebar.style.visibility = "visible";
				// Accent rings around each growing dot, not solid dots on top of the next scene.
				const r0 = (clamp(k) * 72).toFixed(2);
				const r1 = (clamp(k + 0.16) * 72 + 1).toFixed(2);
				const lead = `radial-gradient(circle at center, transparent ${r0}%, #000 ${r0}%, #000 ${r1}%, transparent ${(+r1 + 1).toFixed(2)}%)`;
				set(wipebar, { background: b.ps.accent, clipPath: "none", maskImage: lead, webkitMaskImage: lead, maskSize: size, webkitMaskSize: size, maskPosition: "center", webkitMaskPosition: "center" });
			}
		} else if (kind === "glitch") {
			// Signal breakup: the next scene arrives in torn horizontal bands that jitter sideways,
			// the old one hue-shifts, RGB split spikes, accent bars flicker.
			const st = Math.floor(p * 14);
			const bands = 11;
			const rects = [];
			for (let j = 0; j < bands; j++) {
				const y0 = (j / bands) * H + (hash(j * 3.1 + st) - 0.5) * H * 0.04;
				const y1 = ((j + 1) / bands) * H + (hash(j * 5.7 + st) - 0.5) * H * 0.04;
				if (p > 0.82 || hash(j * 7.13 + st * 3.31) < p * 1.25) rects.push([Math.max(0, y0), Math.min(H, y1)]);
			}
			set(b.root, {
				clipPath: p > 0.88 ? "none" : rects.length ? `polygon(${rects.map(([y0, y1]) => `0 ${px(y0)}, ${px(W)} ${px(y0)}, ${px(W)} ${px(y1)}, 0 ${px(y1)}, 0 ${px(y0)}`).join(", ")})` : "polygon(0 0, 0 0, 0 0)",
				transform: `translateX(${px((hash(st * 1.7) - 0.5) * W * 0.07 * (1 - p))})`,
			});
			// No CSS filters here: a filter over a 3D camera (orbit, float) blanks the scene in Chromium.
			set(a.root, { transform: `translateX(${px((hash(st * 2.3 + 0.4) - 0.5) * W * 0.05)})` });
			set(stage, { background: plan.palette.ink });
			const ab = (18 * Math.sin(p * Math.PI) + 2) * S;
			a.root.style.setProperty("--ab", ab.toFixed(2));
			b.root.style.setProperty("--ab", ab.toFixed(2));
			if (p < 0.9) {
				wipebar.style.visibility = "visible";
				const bars = [0, 1, 2].map((k) => {
					const y = hash(st * 4.7 + k * 1.3) * H;
					const h = (4 + hash(st + k * 9.1) * 22) * S;
					return `0 ${px(y)}, ${px(W)} ${px(y)}, ${px(W)} ${px(y + h)}, 0 ${px(y + h)}, 0 ${px(y)}`;
				});
				set(wipebar, { background: b.ps.accent, clipPath: `polygon(${bars.join(", ")})` });
			}
		} else if (kind === "shutter") {
			// Slats open one after another from their centres; an accent edge leads each one.
			const n = H > W ? 6 : 8;
			const vertical = W >= H;
			const len = vertical ? W : H;
			const sw = len / n;
			const lag = 0.05;
			const slats = (lead) =>
				Array.from({ length: n }, (_, j) => {
					const k = expoInOut(clamp((p + lead - j * lag) / (1 - (n - 1) * lag)));
					const w = k * sw;
					const a0 = j * sw + (sw - w) / 2;
					const a1 = a0 + w;
					return vertical
						? `${px(a0)} 0, ${px(a1)} 0, ${px(a1)} ${px(H)}, ${px(a0)} ${px(H)}, ${px(a0)} 0`
						: `0 ${px(a0)}, 0 ${px(a1)}, ${px(W)} ${px(a1)}, ${px(W)} ${px(a0)}, 0 ${px(a0)}`;
				});
			set(b.root, { clipPath: p >= 1 ? "none" : `polygon(${slats(0).join(", ")})` });
			set(a.root, { transform: `scale(${(1 + 0.05 * cubicInOut(p)).toFixed(4)})` });
			if (p < 0.97) {
				wipebar.style.visibility = "visible";
				set(wipebar, { background: b.ps.accent, clipPath: `polygon(evenodd, ${slats(0.07).join(", ")}, ${slats(0).join(", ")})` });
			}
		} else if (kind === "flip") {
			// A card flip in 3D: the old scene turns away on its vertical axis, the new one turns in.
			const e = cubicInOut(p);
			const ang = e * 180;
			const dip = 1 - 0.14 * Math.sin(p * Math.PI);
			const persp = `perspective(${px(2400 * S)})`;
			set(stage, { background: plan.palette.ink });
			if (ang < 90) {
				set(a.root, { transform: `${persp} rotateY(${(-ang).toFixed(3)}deg) scale(${dip.toFixed(4)})` });
				set(b.root, { opacity: "0" });
			} else {
				set(b.root, { transform: `${persp} rotateY(${(180 - ang).toFixed(3)}deg) scale(${dip.toFixed(4)})` });
				set(a.root, { opacity: "0" });
			}
		} else if (kind === "flash") {
			// Lens flash: the old scene pushes in and blows out to white, the new one comes back out of it.
			const up = expoIn(clamp(p / 0.5));
			const down = expoOut(clamp((p - 0.5) / 0.5));
			// The blow-out is a white overlay, not a brightness filter (filters blank 3D cameras).
			set(a.root, { transform: `scale(${(1 + 0.07 * up).toFixed(4)})` });
			if (p < 0.5) set(b.root, { opacity: "0" });
			else set(b.root, { transform: `scale(${(1.07 - 0.07 * down).toFixed(4)})` });
			const fc = a.focus ?? { x: W / 2, y: H / 2 };
			wipebar.style.visibility = "visible";
			set(wipebar, {
				clipPath: "none",
				opacity: (p < 0.5 ? up : 1 - down).toFixed(3),
				background: `radial-gradient(ellipse 90% 80% at ${px(fc.x)} ${px(fc.y)}, #ffffff 0%, #fffaf0 45%, ${mixHex("#fff4e0", b.ps.accent, 0.35)} 100%)`,
			});
		} else if (kind === "wipe") {
			const e = cubicInOut(p);
			const k = H * 0.35;
			const x = lerp(-k, W + k, e);
			const band = 90 * S;
			set(b.root, { clipPath: `polygon(0 0, ${px(x - band + k)} 0, ${px(x - band - k)} ${px(H)}, 0 ${px(H)})` });
			wipebar.style.visibility = "visible";
			set(wipebar, {
				background: b.ps.accent,
				clipPath: `polygon(${px(x - band + k)} 0, ${px(x + k)} 0, ${px(x - k)} ${px(H)}, ${px(x - band - k)} ${px(H)})`,
			});
		}
	};

	let last = 0;
	window.__state = () => ({ n: built.length, last, scenes: built.map((b) => [b.ps.scene.type, +b.ps.start.toFixed(2), +b.ps.dur.toFixed(2), b.lastVisible, b.root.style.visibility]) });
	window.setupFilm = (p, o) => build(p, o).then(() => ({ duration: plan.duration }));
	let driven = false;
	window.renderFrame = (t) => {
		driven = true;
		last = t;
		draw(t);
		// Two frames: the first commits the new styles, the second guarantees they were presented
		// before the host captures (one frame was not enough under load).
		return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
	};

	// ---------- preview host protocol ----------
	let playing = false;
	let audio = null;
	let clockStart = 0;
	let clockAt = 0;
	let loop = true;
	const now = () => (audio && !audio.paused ? audio.currentTime : clockAt + (playing ? (performance.now() - clockStart) / 1000 : 0));
	const post = (msg) => window.parent !== window && window.parent.postMessage({ source: "kinetic-film", ...msg }, "*");
	const tick = () => {
		if (!plan || driven) return requestAnimationFrame(tick);
		let t = now();
		if (playing && t >= plan.duration) {
			if (loop) {
				seek(0);
				t = 0;
			} else {
				pause();
				t = plan.duration;
			}
		}
		if (playing || t !== last) {
			draw(t);
			last = t;
			post({ kind: "time", t, duration: plan.duration, playing });
		}
		requestAnimationFrame(tick);
	};
	const seek = (t) => {
		clockAt = t;
		clockStart = performance.now();
		if (audio) audio.currentTime = t;
		draw(t);
		last = t;
		post({ kind: "time", t, duration: plan?.duration ?? 0, playing });
	};
	const play = () => {
		if (!plan) return;
		if (now() >= plan.duration - 0.05) seek(0);
		clockAt = now();
		clockStart = performance.now();
		playing = true;
		audio?.play().catch(() => {});
		post({ kind: "state", playing });
	};
	const pause = () => {
		clockAt = now();
		playing = false;
		audio?.pause();
		post({ kind: "state", playing });
	};
	window.addEventListener("message", async (ev) => {
		const m = ev.data;
		if (!m || m.target !== "kinetic-film") return;
		if (m.kind === "load") {
			const at = m.keepTime ? now() : 0;
			const was = playing;
			if (playing) pause();
			await build(m.plan, m.opts ?? {});
			if (audio && audio.src !== m.audio) {
				audio.pause();
				audio = null;
			}
			if (m.audio && !audio) {
				audio = new Audio(m.audio);
				audio.preload = "auto";
			}
			seek(Math.min(at, plan.duration));
			post({ kind: "loaded", duration: plan.duration });
			if (m.autoplay || (was && m.keepTime)) play();
		} else if (m.kind === "audio") {
			const t = now();
			const was = playing;
			if (audio) audio.pause();
			audio = m.audio ? new Audio(m.audio) : null;
			seek(t);
			if (was) play();
		} else if (m.kind === "play") play();
		else if (m.kind === "pause") pause();
		else if (m.kind === "toggle") playing ? pause() : play();
		else if (m.kind === "seek") seek(clamp(m.t, 0, plan?.duration ?? 0));
		else if (m.kind === "loop") loop = !!m.loop;
	});
	requestAnimationFrame(tick);
	post({ kind: "ready" });
})();
