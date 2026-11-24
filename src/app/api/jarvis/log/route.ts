import { userFromRequest } from "@/lib/gmail-server";

export const dynamic = "force-dynamic";

/**
 * Cosmo's diagnostics from the desktop app (wake word, clicks, live chat): written to the server log so
 * problems on Lucas's computer can be read from Vercel. Body: { event, detail? }.
 */
export async function POST(req: Request) {
  const user = await userFromRequest(req);
  if (!user) return new Response(null, { status: 401 });
  const owner = process.env.HUB_OWNER_ID;
  if (owner && user.id !== owner) return new Response(null, { status: 403 });
  const body = (await req.json().catch(() => null)) as { event?: unknown; detail?: unknown } | null;
  const event = String(body?.event ?? "?").slice(0, 60);
  const detail = body?.detail === undefined ? "" : JSON.stringify(body.detail).slice(0, 600);
  console.log(`cosmo-diag ${event} ${detail}`);
  return new Response(null, { status: 204 });
}
