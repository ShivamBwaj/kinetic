// One function for all Kinetic Web account routes (the Hobby plan caps a deployment at 12
// functions). vercel.json rewrites each public URL here with ?r=<route>; the handlers live in
// the underscore files, which Vercel doesn't deploy as functions of their own.
//   /api/auth/google  /api/auth/dev  /api/auth/logout  /api/me  /api/license  /api/export  /api/log  /api/admin
import * as admin from "./_acct-admin.js";
import * as dev from "./_acct-dev.js";
import * as exportApi from "./_acct-export.js";
import * as google from "./_acct-google.js";
import * as license from "./_acct-license.js";
import * as log from "./_acct-log.js";
import * as logout from "./_acct-logout.js";
import * as me from "./_acct-me.js";
import { fail } from "./_auth.js";

const ROUTES = { admin, "auth/google": google, "auth/dev": dev, "auth/logout": logout, me, license, export: exportApi, log };

function routeOf(request) {
	const url = new URL(request.url);
	const r = url.searchParams.get("r");
	if (r) return r;
	// Locally (and if the platform hands over the original URL) the path names the route.
	return url.pathname.replace(/^\/api\//, "");
}

async function handle(request) {
	const mod = Object.hasOwn(ROUTES, routeOf(request)) ? ROUTES[routeOf(request)] : null;
	if (!mod) return fail(404, "Not found.");
	const fn = mod[request.method];
	if (!fn) return fail(405, "Method not allowed.");
	return fn(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
