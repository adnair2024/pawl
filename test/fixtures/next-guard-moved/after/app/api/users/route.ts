import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const json = (b: unknown, status = 200) => NextResponse.json(b, { status });

export async function GET() {
  const client = createClient();
  const result = await client.auth.getUser();
  const account = result.data.user;
  if (!account) {
    return json({ error: "nope" }, 401);
  }
  return json({ id: account.id });
}
