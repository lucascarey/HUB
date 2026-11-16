import { authUrl, gmailConfigured, userFromRequest } from "@/lib/gmail-server";

/** Returns the Google consent URL for the signed-in person. */
export async function POST(req: Request) {
  if (!gmailConfigured()) return Response.json({ error: "not_configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ url: authUrl(new URL(req.url).origin, user.id) });
}
