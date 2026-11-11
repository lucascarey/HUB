import { gmail, gmailConfigured, refreshAccess, supabaseAs, userFromRequest } from "@/lib/gmail-server";

export const dynamic = "force-dynamic";

type ListRes = { messages?: { id: string; threadId: string }[]; resultSizeEstimate?: number };
type MsgRes = {
  id: string; threadId: string; snippet: string; internalDate: string;
  payload: { headers: { name: string; value: string }[] };
};

const QUERY = "is:unread is:important in:inbox";

/** Important unread mail of the signed-in person. */
export async function GET(req: Request) {
  if (!gmailConfigured()) return Response.json({ status: "not_configured" });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ status: "unauthorized" }, { status: 401 });

  const { data: refresh, error } = await supabaseAs(user.token).rpc("hub_gmail_token");
  if (error) return Response.json({ status: "error" }, { status: 500 });
  if (!refresh) return Response.json({ status: "not_connected" });

  try {
    const access = await refreshAccess(refresh as string);
    const list = await gmail<ListRes>(access, `messages?maxResults=12&q=${encodeURIComponent(QUERY)}`);
    const msgs = await Promise.all(
      (list.messages ?? []).map((m) =>
        gmail<MsgRes>(access, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`),
      ),
    );
    const h = (m: MsgRes, n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    return Response.json({
      status: "ok",
      total: list.resultSizeEstimate ?? msgs.length,
      mails: msgs.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        from: h(m, "From").replace(/\s*<[^>]+>/, "").replace(/"/g, "") || h(m, "From"),
        subject: h(m, "Subject") || "(sin asunto)",
        snippet: m.snippet,
        date: Number(m.internalDate),
      })),
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    // Revoked or expired consent: ask to connect again.
    if (code === "invalid_grant") return Response.json({ status: "not_connected" });
    console.error("mail", e);
    return Response.json({ status: "error" }, { status: 502 });
  }
}
