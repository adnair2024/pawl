export async function GET() {
  return new Response("public data", { headers: { "Access-Control-Allow-Origin": "*" } });
}
