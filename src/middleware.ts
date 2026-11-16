import { NextResponse, type NextRequest } from "next/server";

// Un solo dominio para el HUB: la sesión y la conexión con Gmail viven en
// hub-sigma-beige.vercel.app, así que el alias viejo redirige ahí.
const CANONICAL = "hub-sigma-beige.vercel.app";
const OLD_HOSTS = new Set(["hub-lc-4617.vercel.app"]);

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!OLD_HOSTS.has(host)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.host = CANONICAL;
  url.protocol = "https";
  url.port = "";
  return NextResponse.redirect(url, 308);
}

export const config = { matcher: "/((?!_next/static|_next/image|favicon.ico).*)" };
