export default async function handler(request, response) {
  if (request.method !== "GET") return response.status(405).send("Method not allowed");
  const token = Array.isArray(request.query?.id) ? request.query.id[0] : request.query?.id;
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!backendUrl || !/^upload-[a-z0-9-]+$/i.test(String(token || ""))) return response.status(404).send("Upload link expired");
  try {
    const upstream = await fetch(`${backendUrl}/api/more-page?id=${encodeURIComponent(token)}`);
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    return response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    return response.status(502).send("Upload service unavailable");
  }
}
