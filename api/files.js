const FILE_ID_PATTERN = /^host-p[0-9]{3}$/i;

export default async function handler(request, response) {
  if (!["GET", "HEAD", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, HEAD, POST");
    return response.status(405).send("Method not allowed");
  }
  const id = Array.isArray(request.query?.id) ? request.query.id[0] : request.query?.id;
  if (!FILE_ID_PATTERN.test(String(id ?? ""))) return response.status(400).send("Invalid file ID");
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!backendUrl) return response.status(500).send("BACKEND_URL is not configured");

  try {
    const headers = {};
    for (const header of ["content-type", "content-length", "content-range", "accept"]) {
      if (request.headers[header]) headers[header] = request.headers[header];
    }
    const upstream = await fetch(
      request.method === "POST"
        ? `${backendUrl}/api/files`
        : `${backendUrl}/file/${encodeURIComponent(id)}`,
      {
        method: request.method,
        headers,
        body: request.method === "POST" ? request : undefined,
        duplex: request.method === "POST" ? "half" : undefined,
        redirect: "follow",
      },
    );
    response.status(upstream.status);
    for (const header of ["content-type", "content-length", "content-disposition", "cache-control", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) response.setHeader(header, value);
    }
    if (request.method === "HEAD" || !upstream.body) return response.end();
    return response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    console.error("File proxy failed:", error);
    return response.status(502).send("File backend unavailable");
  }
}