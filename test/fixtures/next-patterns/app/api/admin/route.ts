import { redirect } from "next/navigation";
import { auth } from "@/auth";

export async function POST() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await requireAdmin();
  return Response.json({});
}
