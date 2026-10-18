import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guards";

export async function DELETE() {
  await requireAdmin();
  return NextResponse.json({ deleted: true });
}
