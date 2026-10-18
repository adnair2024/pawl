import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  return NextResponse.json({}, { headers: { "Access-Control-Allow-Origin": origin } });
}
