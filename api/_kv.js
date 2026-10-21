// Upstash Redis over its REST API (one fetch per command, no SDK). Keys for Kinetic start with "kinetic:".
export async function redis(...args) {
	const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
	if (!url || !token) throw new Error("store not configured");
	const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args.map(String)), signal: AbortSignal.timeout(5000) });
	if (!r.ok) throw new Error(`store ${r.status}`);
	return (await r.json()).result;
}

/** The founding offer: the first CAP buyers pay $9, then the price is $19. */
export const FOUNDING = {
	product: "pdt_0NqECMy1oc4IZHqFPZeFi",
	cap: 100,
	key: "kinetic:founding:payments",
	checkout: "https://dodo.pe/kinetic-founding",
	regularCheckout: "https://dodo.pe/kinetic-pro-launch",
};

/** Founding licences sold so far (a set of payment ids, so a retried webhook never counts twice). */
export const foundingSold = async () => Number(await redis("SCARD", FOUNDING.key)) || 0;
