import { supabaseAs } from "@/lib/gmail-server";

export const dynamic = "force-dynamic";

/**
 * Called once a day by a Vercel cron so the free Supabase project never sits idle long enough to be paused.
 * The query returns nothing (row security), but it still reaches the database.
 */
export async function GET() {
  const { error } = await supabaseAs().from("items").select("id").limit(1);
  return Response.json({ ok: !error });
}
