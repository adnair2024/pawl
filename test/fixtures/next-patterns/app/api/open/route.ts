export async function GET() {
  const rows = await loadPublicRows();
  if (!rows) throw new Error("empty");
  return Response.json(rows);
}
