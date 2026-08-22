export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!backendUrl) return response.status(500).json({ error: "BACKEND_URL is not configured" });
  try {
    const upstream = await fetch(`${backendUrl}/api/more-auth`, {
      method: "POST",
      headers: { "content-type": request.headers["content-type"] || "application/json" },
      body: request,
      duplex: "half",
    });
    response.status(upstream.status);
    response.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
    return response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error("Upload authentication proxy failed:", error);
    return response.status(502).json({ error: "Upload service unavailable" });
  }
}
