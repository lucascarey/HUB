import { calendar, gmailConfigured, refreshAccess, supabaseAs, userFromRequest } from "@/lib/gmail-server";
import { TZ, todayISO } from "@/lib/jarvis-tools";

export const dynamic = "force-dynamic";

type GEvent = {
  id: string; summary?: string; location?: string; htmlLink?: string;
  start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string };
};

/** The next days of Google Calendar (primary), for the brain's "Agenda" lobe. */
export async function GET(req: Request) {
  if (!gmailConfigured()) return Response.json({ status: "not_configured" });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ status: "unauthorized" }, { status: 401 });
  const { data: refresh } = await supabaseAs(user.token).rpc("hub_gmail_token");
  if (!refresh) return Response.json({ status: "not_connected" });
  const days = Math.min(14, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 7));
  try {
    const access = await refreshAccess(refresh as string);
    const start = todayISO();
    const end = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const p = new URLSearchParams({
      timeMin: `${start}T00:00:00-03:00`, timeMax: `${end}T23:59:59-03:00`,
      singleEvents: "true", orderBy: "startTime", maxResults: "40", timeZone: TZ,
    });
    const res = await calendar<{ items: GEvent[] }>(access, `events?${p}`);
    return Response.json({
      status: "ok",
      events: res.items.map((e) => ({
        id: e.id, title: e.summary ?? "(sin título)", start: e.start.dateTime ?? e.start.date ?? "",
        allDay: !!e.start.date, link: e.htmlLink ?? null,
      })),
    });
  } catch (e) {
    const msg = String(e);
    if (/invalid_grant/.test(msg)) return Response.json({ status: "not_connected" });
    if (/Calendar 403/.test(msg)) return Response.json({ status: "no_calendar" });
    console.error("agenda", e);
    return Response.json({ status: "error" }, { status: 502 });
  }
}
