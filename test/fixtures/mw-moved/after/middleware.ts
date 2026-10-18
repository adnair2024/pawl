import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC = ["/login", "/api/public"];

export async function middleware(req: NextRequest) {
  if (PUBLIC.some((p) => req.nextUrl.pathname.startsWith(p))) return NextResponse.next();
  const sessionCookie = req.cookies.get("session");
  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!login|api/public|_next/static|_next/image|favicon.ico).*)"] };
