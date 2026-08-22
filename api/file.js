const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export default async function handler(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).send("Method not allowed");
  }

  const queryId = Array.isArray(request.query?.id) ? request.query.id[0] : request.query?.id;
  const pathId = String(request.url ?? "").match(/\/image\/([^?/#]+)/i)?.[1];
  let id;
  try {
    id = decodeURIComponent(String(queryId ?? pathId ?? "")).trim();
  } catch {
    return response.status(400).send("Invalid image ID");
  }
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!backendUrl) return response.status(500).send("BACKEND_URL is not configured");
  if (request.method === "GET" && id.startsWith("upload-")) {
    try {
      // Open the one-time session on the real backend and return the full
      // styled page. The old inline fallback never opened the session.
      const upstream = await fetch(`${backendUrl}/api/more-page?id=${encodeURIComponent(id)}`, {
        redirect: "follow",
      });
      response.status(upstream.status);
      response.setHeader("Content-Type", upstream.headers.get("content-type") || "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      return response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      console.error("Upload page proxy failed:", error);
      return response.status(502).send("Upload service unavailable");
    }
  }
  if (!SLUG_PATTERN.test(id)) return response.status(400).send("Invalid image ID");

  try {
    const upstream = await fetch(`${backendUrl}/image/${encodeURIComponent(id)}`, {
      method: request.method,
      redirect: "follow",
    });
    response.status(upstream.status);
    for (const header of ["content-type", "content-length", "cache-control", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) response.setHeader(header, value);
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD" || !upstream.body) return response.end();
    return response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error("Image proxy failed:", error);
    return response.status(502).send("Image backend unavailable");
  }
}
