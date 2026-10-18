import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  // refreshes the cookie but never refuses anyone
  return NextResponse.next({ request });
}
