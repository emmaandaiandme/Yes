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
  if (request.method === "GET" && id.startsWith("upload-")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    return response.status(200).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Larger image upload</title><style>body{font-family:system-ui;max-width:560px;margin:12vh auto;padding:24px;color:#172033}input,button{font:inherit;margin-top:16px}button{display:block;padding:10px 18px;background:#635bff;color:white;border:0;border-radius:8px}#s{margin-top:18px;word-break:break-word}</style><h1>Larger image upload</h1><p>Choose one image up to 50 MB. Your link will appear here.</p><input id="f" type="file" accept="image/*"><button id="b">Upload image</button><div id="s"></div><script>b.onclick=async()=>{const f=document.querySelector("#f").files[0],s=document.querySelector("#s");if(!f){s.textContent="Choose an image first.";return}b.disabled=true;s.textContent="Uploading…";const x=new FormData;x.append("image",f);x.append("session",location.pathname.split("/").pop());try{const r=await fetch("/api/more-upload",{method:"POST",body:x}),j=await r.json();if(!r.ok)throw Error(j.error);const u=new URL(j.url,location.origin);s.innerHTML="Uploaded: <a href='"+u.href+"'>"+u.href+"</a>"}catch(e){s.textContent=e.message}finally{b.disabled=false}}</script>`);
  }
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!SLUG_PATTERN.test(id)) return response.status(400).send("Invalid image ID");
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
