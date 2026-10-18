import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOWED = ["https://app.example.com"];

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  const origin = request.headers.get("origin");
  if (origin && ALLOWED.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  }
  return response;
}
