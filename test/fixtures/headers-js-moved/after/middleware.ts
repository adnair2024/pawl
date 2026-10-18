import { NextResponse } from "next/server";

export function middleware() {
  const res = NextResponse.next();
  res.headers.set("x-frame-options", "SAMEORIGIN");
  res.headers.set("Content-Security-Policy", "default-src 'self'");
  return res;
}
