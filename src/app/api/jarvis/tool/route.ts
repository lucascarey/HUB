import { supabaseAs, userFromRequest } from "@/lib/gmail-server";
import { jarvisTools, type Changed } from "@/lib/jarvis-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Runs one of Cosmo's tools for the live voice chat. Body: { name, args }. Returns { output, changed }. */
export async function POST(req: Request) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const owner = process.env.HUB_OWNER_ID;
  if (owner && user.id !== owner) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { name?: string; args?: unknown } | null;
  const changed: Changed = { hub: false, calendar: false, memory: false };
  const tool = jarvisTools(supabaseAs(user.token), changed).find((t) => t.name === body?.name);
  if (!tool) return Response.json({ output: `No existe la herramienta ${body?.name}.`, changed });
  const args = tool.inputSchema.safeParse(body?.args ?? {});
  if (!args.success) return Response.json({ output: `Argumentos inválidos: ${args.error.message.slice(0, 300)}`, changed });
  try {
    const output = await (tool.run as (a: unknown) => Promise<string>)(args.data);
    return Response.json({ output, changed });
  } catch (e) {
    console.error("jarvis tool", body?.name, e);
    return Response.json({ output: `Error: ${String(e).slice(0, 200)}`, changed });
  }
}
