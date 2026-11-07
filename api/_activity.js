// Activity for the /admin page: what each Kinetic Web account did (sign-ins, AI prompts, exports,
// errors) and a site-wide feed that also has the homepage try-it prompts. Recorded only for
// signed-in web accounts and the website's try-it box; desktop app users are never recorded.
// Never throws: a store hiccup must not break the request that's being recorded.
import { redis } from "./_kv.js";

const FEED = "kinetic:feed";
const FEED_MAX = 2000;
const USER_MAX = 400;
export const actKey = (sub) => `kinetic:act:${sub}`;
export const statsKey = (sub) => `kinetic:ustats:${sub}`;

const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);

/** kind: signup, signin, onboarded, write, scene, write.denied, export.start, export, export.failed, license.link, license.unlink, error, try */
export async function record(sub, kind, data = {}) {
	try {
		const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? v : clip(v, 600)]));
		const entry = JSON.stringify({ t: Date.now(), ...(sub ? { sub } : {}), kind, ...clean });
		const ops = [redis("LPUSH", FEED, entry).then(() => redis("LTRIM", FEED, 0, FEED_MAX - 1))];
		if (sub) {
			ops.push(redis("LPUSH", actKey(sub), entry).then(() => redis("LTRIM", actKey(sub), 0, USER_MAX - 1)));
			ops.push(redis("HINCRBY", statsKey(sub), kind, 1));
		}
		await Promise.all(ops);
	} catch (e) {
		console.error("activity", e.message);
	}
}

/** The visitor's text out of a writer request: the film brief, or a scene-edit instruction. */
export function promptOf(messages) {
	const text = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
	return (text.match(/BRIEF: (.*)/)?.[1] ?? text.match(/Instruction: (.*)/)?.[1] ?? "").trim();
}
