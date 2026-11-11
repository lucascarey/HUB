import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Falta la variable ${k}`);
  return v;
};

export const gmailConfigured = () =>
  !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET && !!process.env.HUB_STATE_SECRET && !!process.env.HUB_DB_SECRET;

const supabaseUrl = () => env("NEXT_PUBLIC_SUPABASE_URL");
const supabaseKey = () =>
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

/** A Supabase client that acts as the person whose access token is given. */
export function supabaseAs(accessToken?: string) {
  return createClient(supabaseUrl(), supabaseKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

export async function userFromRequest(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabaseAs(token).auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, token };
}

export const redirectUri = (origin: string) => `${origin}/api/gmail/callback`;

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => createHmac("sha256", env("HUB_STATE_SECRET")).update(payload).digest("base64url");

/** state = payload.signature, valid for 10 minutes. */
export function makeState(userId: string) {
  const payload = b64(JSON.stringify({ u: userId, exp: Date.now() + 10 * 60_000 }));
  return `${payload}.${sign(payload)}`;
}

export function readState(state: string | null): string | null {
  if (!state) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof u === "string" && Date.now() < exp ? u : null;
  } catch {
    return null;
  }
}

export function authUrl(origin: string, userId: string) {
  const p = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: makeState(userId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error_description ?? json.error ?? "token"), { code: json.error });
  return json as { access_token: string; refresh_token?: string };
}

export const exchangeCode = (code: string, origin: string) =>
  tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri(origin) });

export const refreshAccess = (refresh_token: string) =>
  tokenRequest({ refresh_token, grant_type: "refresh_token" }).then((t) => t.access_token);

export async function gmail<T>(access: string, path: string): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { authorization: `Bearer ${access}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}`);
  return res.json() as Promise<T>;
}

export async function saveToken(userId: string, refreshToken: string, email: string) {
  const { error } = await supabaseAs().rpc("hub_save_gmail_token", {
    p_user: userId, p_token: refreshToken, p_email: email, p_secret: env("HUB_DB_SECRET"),
  });
  if (error) throw error;
}
