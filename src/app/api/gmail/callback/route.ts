import { exchangeCode, gmail, readState, saveToken } from "@/lib/gmail-server";

/** Google sends the person back here after they allow (or deny) access. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (result: string) => Response.redirect(`${url.origin}/?gmail=${result}`, 302);
  if (url.searchParams.get("error")) return back("denied");
  const userId = readState(url.searchParams.get("state"));
  const code = url.searchParams.get("code");
  if (!userId || !code) return back("error");
  try {
    const tokens = await exchangeCode(code, url.origin);
    if (!tokens.refresh_token) return back("error");
    const profile = await gmail<{ emailAddress: string }>(tokens.access_token, "profile");
    await saveToken(userId, tokens.refresh_token, profile.emailAddress);
    return back("ok");
  } catch (e) {
    console.error("gmail callback", e);
    return back("error");
  }
}
