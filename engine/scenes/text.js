// Text scenes: inline-chip captions, a typewriter, word-by-word sentences, word appends and a
// countdown. Each is a pure function of the scene clock, built from the kit (K) the engine hands it.
(() => {
	const S_ = (window.KineticScenes ??= {});

	/** Digits in a string roll like an odometer; everything else stays put. */
	const rollingNumber = (K, parent, text, size) => {
		const { el, set } = K;
		const box = el("span", "", parent);
		set(box, { display: "inline-flex", overflow: "hidden", height: "1.15em", verticalAlign: "bottom", fontVariantNumeric: "tabular-nums", whiteSpace: "pre" });
		const cols = [];
		for (const ch of String(text)) {
			if (/\d/.test(ch)) {
				const col = el("span", "", box);
				set(col, { display: "inline-flex", flexDirection: "column", lineHeight: "1.15em" });
				for (let d = 0; d <= 9; d++) el("span", "", col, String(d));
				cols.push({ col, digit: Number(ch) });
			} else el("span", "", box, ch);
		}
		/** k: 0 -> 1 progress; digits spin through extra turns, leftmost slowest. */
		return (k, live = 0) => {
			cols.forEach(({ col, digit }, i) => {
				const turns = Math.max(0, cols.length - i - 1);
				const v = (digit + turns * 10) * k + (i === cols.length - 1 ? live : 0);
				const pos = v % 10;
				set(col, { transform: `translateY(${(-pos * 1.15).toFixed(4)}em)` });
			});
		};
	};

	/** "Your rival just hit [$100,412] in MRR." Chips are pills; digits inside them roll. */
	S_.caption = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, fit, clamp, expoOut, spring, prog, alpha, textOn, images } = K;
		const s = p.scene;
		const img = s.image ? images[s.image] : null;
		const vertical = H > W * 1.2;
		const wrap = el("div", "center", cam);
		set(wrap, { justifyContent: img ? "flex-start" : "center", paddingTop: img ? px(H * 0.08) : "0", boxSizing: "border-box" });
		const line = el("div", "bold", wrap);
		set(line, { color: fg, fontWeight: "650", letterSpacing: "-0.03em", lineHeight: "1.25", textAlign: "center", maxWidth: px(W * 0.86) });
		const parts = [];
		const tokens = String(s.text).split(/(\[[^\]]+\])/).filter(Boolean);
		for (const [ti, tok0] of tokens.entries()) {
			let tok = tok0;
			// Punctuation right after a chip stays glued to it instead of wrapping onto its own line.
			const lead = ti > 0 && /^\[/.test(tokens[ti - 1]) ? /^[.,!?;:…]+/.exec(tok) : null;
			if (lead) tok = tok.slice(lead[0].length);
			if (!tok) continue;
			const chip = /^\[(.+)\]$/.exec(tok);
			if (chip) {
				const tail = /^[.,!?;:…]+/.exec(tokens[ti + 1] ?? "")?.[0];
				const holder = tail ? el("span", "", line) : line;
				if (tail) set(holder, { display: "inline-block", whiteSpace: "nowrap" });
				const c = el("span", "pill", holder);
				set(c, { background: alpha(fg, 0.08), border: `${px(2 * S)} solid ${alpha(fg, 0.14)}`, padding: "0.06em 0.42em 0.08em 0.3em", margin: "0 0.12em", gap: "0.28em", verticalAlign: "0.06em", lineHeight: "1.1", display: "inline-flex", alignItems: "center" });
				const dot = el("span", "", c);
				set(dot, { width: "0.5em", height: "0.5em", borderRadius: "50%", background: accent, flex: "none" });
				const hasDigits = /\d/.test(chip[1]);
				const roll = hasDigits ? rollingNumber(K, c, chip[1]) : null;
				if (!hasDigits) el("span", "", c, chip[1]);
				if (tail) el("span", "", holder, tail);
				parts.push({ node: tail ? holder : c, chip: true, roll });
			} else
				for (const w of tok.split(/(\s+)/)) {
					if (!w) continue;
					if (/^\s+$/.test(w)) {
						line.appendChild(document.createTextNode(" "));
						continue;
					}
					parts.push({ node: el("span", "word", line, w) });
				}
		}
		fit(line, W * 0.86, img ? H * 0.16 : H * 0.42, (img ? 70 : 110) * S, 20);
		let sub = null;
		if (s.sub) {
			sub = el("div", "bold", wrap, s.sub);
			set(sub, { color: fg, opacity: "0.6", fontWeight: "550", letterSpacing: "-0.015em", fontSize: px(Math.max(26 * S, Number.parseFloat(line.style.fontSize) * 0.5)), marginTop: px(16 * S) });
		}
		let card = null;
		if (img) {
			const aspect = img.w / img.h;
			let cw = W * (vertical ? 0.86 : 0.56);
			let ch = cw / aspect;
			const maxH = H * 0.62;
			if (ch > maxH) {
				ch = maxH;
				cw = ch * aspect;
			}
			card = el("div", "card", cam);
			set(card, { left: px((W - cw) / 2), top: px(H - ch - H * 0.07), width: px(cw), height: px(ch), borderRadius: px(18 * S), boxShadow: `0 ${px(40 * S)} ${px(90 * S)} rgba(0,0,0,0.25)` });
			const im = el("img", "fill", card);
			im.src = img.src;
		}
		const step = Math.min(0.09, 0.7 / Math.max(1, parts.length));
		return (l) => {
			parts.forEach((pt, i) => {
				const t0 = 0.03 + i * step;
				const k = spring(l - t0, pt.chip ? 2.8 : 3.4, pt.chip ? 0.5 : 0.7);
				set(pt.node, {
					opacity: clamp((l - t0) / 0.08).toFixed(3),
					transform: pt.chip ? `scale(${(0.6 + 0.4 * k).toFixed(4)})` : `translateY(${((1 - k) * 0.4).toFixed(4)}em)`,
					filter: `blur(${px((1 - clamp(k)) * 8 * S)})`,
				});
				// The number lands on exactly what was written and stays there.
				if (pt.roll) pt.roll(expoOut(prog(l, t0, 0.9)));
			});
			if (sub) {
				const k = expoOut(prog(l, 0.35 + parts.length * step, 0.5));
				set(sub, { opacity: (0.6 * k).toFixed(3), transform: `translateY(${px((1 - k) * 18 * S)})` });
			}
			if (card) {
				const k = expoOut(prog(l, 0.25, 0.8));
				set(card, { opacity: clamp(l / 0.15).toFixed(3), transform: `translateY(${px((1 - k) * H * 0.4)}) rotateX(${((1 - k) * 18).toFixed(2)}deg)` });
			}
		};
	};

	/** Typed on a blank page with a human rhythm; can erase the end and type something else. */
	S_.typewriter = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, fit, hash } = K;
		const s = p.scene;
		const wrap = el("div", "center", cam);
		const line = el("div", "bold", wrap);
		set(line, { color: fg, fontWeight: "600", letterSpacing: "-0.03em", whiteSpace: "pre-wrap", maxWidth: px(W * 0.8), textAlign: "center" });
		const typed = el("span", "", line);
		const caret = el("span", "caret", line);
		set(caret, { width: "0.06em", height: "1em", background: accent, marginLeft: "0.04em" });
		// The schema trims "then", so put the word gap back unless it starts with punctuation.
		const then = s.then && !s.erase && !/\s$/.test(s.text) && !/^[\s,.;:!?…]/.test(s.then) ? ` ${s.then}` : (s.then ?? "");
		const finalText = (s.erase ? s.text.slice(0, Math.max(0, s.text.length - s.erase)) : s.text) + then;
		typed.textContent = s.text.length > finalText.length ? s.text : finalText;
		fit(line, W * 0.8, H * 0.3, 124 * S, 20);
		// A keystroke schedule: uneven gaps, longer after spaces and punctuation.
		const times = [];
		let t = 0.15;
		const push = (ch, i, k) => {
			t += 0.035 + hash(i * 3.7 + k) * 0.04 + (/[\s,.]/.test(ch) ? 0.05 : 0);
			times.push(t);
		};
		[...s.text].forEach((ch, i) => push(ch, i, 1));
		const typedEnd = t;
		const eraseStart = typedEnd + 0.35;
		const eraseEnd = eraseStart + (s.erase ?? 0) * 0.03;
		t = eraseEnd + 0.15;
		const thenTimes = [];
		[...then].forEach((ch, i) => {
			t += 0.04 + hash(i * 5.1 + 9) * 0.04 + (/[\s,.]/.test(ch) ? 0.05 : 0);
			thenTimes.push(t);
		});
		const total = t || typedEnd;
		const scale = Math.min(1, (p.dur * 0.85) / Math.max(0.1, total));
		return (l) => {
			const lt = l / scale;
			let n = times.filter((x) => x <= lt).length;
			let text = s.text.slice(0, n);
			if (s.erase && lt > eraseStart) {
				const gone = Math.min(s.erase, Math.floor((lt - eraseStart) / 0.03));
				text = s.text.slice(0, s.text.length - gone);
			}
			if (then && lt > eraseEnd) text += then.slice(0, thenTimes.filter((x) => x <= lt).length);
			if (typed.textContent !== text) typed.textContent = text;
			const idle = lt > total || (lt > typedEnd && lt < eraseStart);
			set(caret, { opacity: idle && Math.floor(l * 2.6) % 2 ? "0" : "1" });
			n = 0;
		};
	};

	/** A sentence landing word by word, big, each word in its own colour. */
	S_.sentence = ({ p, cam, fg, palette, bg, K }) => {
		const { W, H, fit, S, el, set, spring, clamp, lum, glyphText } = K;
		const s = p.scene;
		const wrap = el("div", "center", cam);
		const line = el("div", "display", wrap);
		set(line, { color: fg });
		const { words } = glyphText(line, s.text, { glyphs: false });
		const light = lum(bg) > 0.4;
		const pool = [palette.electric, palette.coral, palette.peach, palette.sage, palette.lilac, palette.lime, palette.butter].filter((c) => Math.abs(lum(c) - lum(bg)) > 0.3);
		words.forEach((w, i) => {
			if (i % 2 === 1 && pool.length) w.node.style.color = pool[i % pool.length];
		});
		fit(line, W * 0.86, H * 0.66, 200 * S);
		const step = Math.min(p.beatLen / 2, (p.dur * 0.6) / Math.max(1, words.length));
		return (l) => {
			words.forEach((w, i) => {
				const t0 = 0.02 + i * step;
				const k = spring(l - t0, 3.6, 0.55);
				set(w.node, { opacity: clamp((l - t0) / 0.05).toFixed(3), transform: `translateY(${((1 - k) * 0.55).toFixed(4)}em) scale(${(0.85 + 0.15 * k).toFixed(4)})` });
			});
			void light;
		};
	};

	/** "Zero" stays; the word after it rolls through a mask line on every beat. */
	S_.append = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, px, fitLine, expoOut, expoIn, prog, clamp } = K;
		const s = p.scene;
		const marks = p.marks ?? s.words.map((_, i) => 0.5 + i * p.beatLen);
		const vertical = H > W * 1.2;
		const wrap = el("div", "center", cam);
		const row = el("div", "display", wrap);
		set(row, { color: fg, display: "flex", flexDirection: vertical ? "column" : "row", alignItems: vertical ? "center" : "baseline", gap: "0.22em", whiteSpace: "nowrap" });
		const baseEl = el("span", "", row, s.base);
		const slot = el("span", "", row);
		set(slot, { position: "relative", display: "inline-block", overflow: "hidden", height: "1.05em", paddingBottom: "0.1em" });
		const longest = s.words.reduce((a, b) => (b.length > a.length ? b : a), "");
		const sizer = el("span", "", slot, longest);
		set(sizer, { visibility: "hidden" });
		const items = s.words.map((w) => {
			const n = el("span", "", slot, w);
			set(n, { position: "absolute", left: vertical ? "50%" : "0", top: "0", color: accent, whiteSpace: "nowrap" });
			return n;
		});
		// Size the slot by the widest word as set, not the one with the most letters.
		sizer.textContent = items.reduce((a, n) => (n.offsetWidth > a.offsetWidth ? n : a), items[0]).textContent;
		fitLine(row, W * 0.9, H * (vertical ? 0.5 : 0.4), 300 * S);
		const baseK = (l) => expoOut(prog(l, 0.02, 0.5));
		return (l) => {
			const bk = baseK(l);
			set(baseEl, { transform: `translateY(${((1 - bk) * 0.6).toFixed(4)}em)`, opacity: clamp(l / 0.08).toFixed(3) });
			items.forEach((n, i) => {
				const inK = expoOut(prog(l, marks[i], 0.35));
				const outAt = i + 1 < items.length ? marks[i + 1] : 1e9;
				const outK = expoIn(prog(l, outAt - 0.06, 0.2));
				const x = vertical ? "translateX(-50%) " : "";
				set(n, { transform: `${x}translateY(${((1 - inK) * 1.1 - outK * 1.1).toFixed(4)}em)`, opacity: l >= marks[i] - 0.01 && outK < 1 ? "1" : "0" });
			});
			void px;
		};
	};

	/** 3, 2, 1, LIVE: each number slams on its beat. */
	S_.countdown = ({ p, cam, fg, accent, K }) => {
		const { W, H, S, el, set, fitLine, spring, clamp, expoIn, prog, misreg } = K;
		const s = p.scene;
		const n = s.from;
		const marks = p.marks ?? Array.from({ length: n + 1 }, (_, i) => i * p.beatLen);
		const labels = [...Array.from({ length: n }, (_, i) => String(n - i)), s.label ?? "GO"];
		const wrap = el("div", "center", cam);
		const nodes = labels.map((txt, i) => {
			const d = el("div", "display", wrap, txt);
			set(d, { position: "absolute", color: i === labels.length - 1 ? accent : fg, fontVariantNumeric: "tabular-nums" });
			fitLine(d, W * 0.86, H * 0.72, 900 * S);
			return d;
		});
		return (l) => {
			nodes.forEach((d, i) => {
				const at = marks[i];
				const next = i + 1 < nodes.length ? marks[i + 1] : 1e9;
				const k = spring(l - at, 3.8, 0.5);
				const out = expoIn(prog(l, next - 0.08, 0.12));
				const on = l >= at && l < next + 0.06;
				set(d, { opacity: on ? (clamp((l - at) / 0.03) * (1 - out)).toFixed(3) : "0", transform: `scale(${(1.6 - 0.6 * k + out * 0.4).toFixed(4)})` });
				misreg(d, on ? 1 - prog(l, at + 0.04, 0.18) : 0);
			});
		};
	};
})();
