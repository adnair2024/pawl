"use server";
import { getSession } from "@/lib/session";

export async function createPost(form: FormData) {
  const session = await getSession();
  if (!session) throw new Error("not signed in");
  return form;
}

export async function publicPing() {
  return "pong";
}
