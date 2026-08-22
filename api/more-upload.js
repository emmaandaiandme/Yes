export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).send("Method not allowed");
  }
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!backendUrl) return response.status(500).json({ error: "BACKEND_URL is not configured" });
  try {
    const headers = {};
    for (const header of ["content-type", "content-length", "x-upload-mode"]) {
      if (request.headers[header]) headers[header] = request.headers[header];
    }
    // Preserve ?chunk=N so the backend selects its 3 MB chunk parser instead
    // of treating the multipart request as a legacy `image` upload.
    const query = new URL(request.url || "/", "https://vercel.invalid").search;
    const upstream = await fetch(`${backendUrl}/api/more-upload${query}`, {
      method: "POST",
      headers,
      body: request,
      duplex: "half",
    });
    response.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) response.setHeader("content-type", contentType);
    return response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error("Larger upload proxy failed:", error);
    return response.status(502).json({ error: "Image backend unavailable" });
  }
}
