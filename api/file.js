const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).send("Method not allowed");
  }

  const id = Array.isArray(request.query.id) ? request.query.id[0] : request.query.id;
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");

  if (!UUID_PATTERN.test(id ?? "")) return response.status(400).send("Invalid image ID");
  if (!backendUrl) return response.status(500).send("BACKEND_URL is not configured");

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
