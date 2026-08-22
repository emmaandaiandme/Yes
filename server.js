const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_MORE_FILE_SIZE = 100 * 1024 * 1024;
const MAX_ARCHIVE_SIZE = 70 * 1024 * 1024;
const uploadDirectory = path.join(__dirname, "uploads");
const fileDirectory = path.join(uploadDirectory, "files");
const partsDirectory = path.join(uploadDirectory, ".more-parts");
const supportedTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/tiff",
]);
const signatures = {
  "image/png": (buffer) => buffer.length >= 24
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && buffer.toString("ascii", 12, 16) === "IHDR",
  "image/jpeg": (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  "image/gif": (buffer) => buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)),
  "image/webp": (buffer) => buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP",
  "image/bmp": (buffer) => buffer.length >= 2 && buffer.toString("ascii", 0, 2) === "BM",
  "image/tiff": (buffer) => buffer.length >= 4 && ["49492a00", "4d4d002a"].includes(buffer.subarray(0, 4).toString("hex")),
  "image/avif": (buffer) => buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp"
    && ["avif", "avis", "mif1", "msf1"].includes(buffer.toString("ascii", 8, 12)),
};
const isValidImageBuffer = (buffer, contentType) => Boolean(signatures[contentType]?.(buffer));
const expiredPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Upload link expired</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f5f7fb;color:#172033;font:16px system-ui,sans-serif}.card{width:min(520px,100%);padding:40px 28px;text-align:center;background:#fff;border:1px solid #dfe5ef;border-radius:24px;box-shadow:0 18px 60px #52607d18}svg{width:112px;height:112px;margin:0 auto 20px}h1{margin:0 0 10px;letter-spacing:-.04em}p{margin:0;color:#667085;line-height:1.6}</style></head><body><main class="card"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="#eeeaff"/><path d="M38 48h44v42H38zM44 48v-8a16 16 0 0 1 32 0v8" fill="none" stroke="#635bff" stroke-width="7" stroke-linecap="round"/><circle cx="60" cy="67" r="4" fill="#635bff"/><path d="M60 71v9" stroke="#635bff" stroke-width="5" stroke-linecap="round"/></svg><h1>This upload link has expired</h1><p>For your security, larger upload links work once and expire when opened. Return to Discord and use <strong>/more</strong> to create a fresh link.</p></main></body></html>`;

fs.mkdirSync(uploadDirectory, { recursive: true });
fs.mkdirSync(fileDirectory, { recursive: true });
const db = new Database(path.join(uploadDirectory, "data.db"));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.pragma("wal_autocheckpoint = 1000");
db.exec(`
  CREATE TABLE IF NOT EXISTS hosted_images (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    view_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS hosted_files (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    data BLOB
  );
  CREATE INDEX IF NOT EXISTS hosted_files_created_at_idx ON hosted_files (created_at DESC);
  CREATE TABLE IF NOT EXISTS more_upload_sessions (
    token TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    opened_at TEXT,
    used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS more_upload_sessions_expiry_idx ON more_upload_sessions (expires_at);
`);
if (!db.pragma("table_info(hosted_images)").some((column) => column.name === "view_count")) {
  db.exec("ALTER TABLE hosted_images ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0");
}
if (!db.pragma("table_info(hosted_files)").some((column) => column.name === "data")) {
  db.exec("ALTER TABLE hosted_files ADD COLUMN data BLOB");
}

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadDirectory),
  filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!supportedTypes.has(file.mimetype)) {
      return callback(new Error("Unsupported image type. Use PNG, JPG, GIF, WebP, BMP, AVIF, or TIFF."));
    }
    callback(null, true);
  },
});
const moreUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MORE_FILE_SIZE, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!supportedTypes.has(file.mimetype)) return callback(new Error("Unsupported image type."));
    callback(null, true);
  },
});
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
});
const archiveExtensions = new Set([".zip", ".tar.xz", ".rar", ".7z"]);
const archiveUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, fileDirectory),
    filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`),
  }),
  limits: { fileSize: MAX_ARCHIVE_SIZE, files: 1 },
  fileFilter: (_request, file, callback) => {
    const name = String(file.originalname || "").toLowerCase();
    if (!Array.from(archiveExtensions).some((extension) => name.endsWith(extension))) {
      return callback(new Error("Unsupported archive. Use .zip, .tar.xz, .rar, or .7z."));
    }
    callback(null, true);
  },
});

async function assembleMoreChunks(session, total) {
  const chunks = [];
  for (let index = 0; index < total; index += 1) {
    chunks.push(await fs.promises.readFile(path.join(partsDirectory, `${session}-${index}.part`)));
  }
  await Promise.all(chunks.map((_chunk, index) => fs.promises.rm(path.join(partsDirectory, `${session}-${index}.part`), { force: true })));
  return Buffer.concat(chunks);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname, { extensions: ["html"] }));

app.get("/image/upload-:owner", (request, response) => {
  const token = `upload-${request.params.owner}`;
  const now = new Date().toISOString();
  db.prepare("DELETE FROM more_upload_sessions WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
  const session = db.prepare(
    `UPDATE more_upload_sessions SET opened_at = ?
     WHERE token = ? AND opened_at IS NULL AND used_at IS NULL AND expires_at > ?
     RETURNING token`,
  ).get(now, token, now);
  if (!session) return response.status(404).set("Cache-Control", "no-store").type("html").send(expiredPage);
  response.set("Cache-Control", "no-store").sendFile(path.join(__dirname, "more-upload.html"));
});

app.get("/api/health", async (_request, response) => {
  try {
    db.prepare("SELECT 1").get();
    response.json({ ok: true, service: "image-host", storage: "shared" });
  } catch (error) {
    console.error("Health check failed:", error.message);
    response.status(503).json({ ok: false, error: "Database unavailable" });
  }
});

app.get("/api/more-page", (request, response) => {
  const token = String(request.query?.id || "");
  const now = new Date().toISOString();
  db.prepare("DELETE FROM more_upload_sessions WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
  const session = db.prepare(
    `UPDATE more_upload_sessions SET opened_at = ?
     WHERE token = ? AND opened_at IS NULL AND used_at IS NULL AND expires_at > ?
     RETURNING token`,
  ).get(now, token, now);
  if (!session) return response.status(404).set("Cache-Control", "no-store").type("html").send(expiredPage);
  response.set("Cache-Control", "no-store").sendFile(path.join(__dirname, "more-upload.html"));
});

app.post("/api/upload", (request, response) => {
  upload.single("image")(request, response, async (error) => {
    if (error) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return response.status(413).json({ error: "That image is larger than the 20 MB Discord upload limit. Use /more for larger images." });
      }
      return response.status(400).json({ error: error.message || "Upload failed." });
    }

    if (!request.file) {
      return response.status(400).json({ error: "Choose an image to upload." });
    }
    if (!isValidImageBuffer(request.file.buffer, request.file.mimetype)) {
      return response.status(400).json({ error: "The file contents do not match a supported image type." });
    }

    const id = crypto.randomUUID();
    try {
      const originalName = request.file.originalname.slice(0, 500);
      db.prepare(
        `INSERT INTO hosted_images
          (id, owner_id, original_name, content_type, size_bytes, data, created_at, slug)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        "website",
        originalName,
        request.file.mimetype,
        request.file.size,
        request.file.buffer,
        new Date().toISOString(),
        id,
      );
      response.status(201).json({
        id,
        name: originalName,
        size: request.file.size,
        url: `/image/${id}`,
      });
    } catch (dbError) {
      console.error("Could not save upload metadata:", dbError);
      response.status(500).json({ error: "The image could not be saved. Please try again." });
    }
  });
});

app.post("/api/more-upload", (request, response) => {
  if (request.query?.chunk !== undefined) {
    return chunkUpload.single("chunk")(request, response, async (error) => {
      if (error) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return response.status(status).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Each upload part must be 3 MB or smaller." : error.message || "Upload failed." });
      }
      const sessionToken = String(request.body?.session || "");
      const index = Number(request.body?.index);
      const total = Number(request.body?.total);
      if (!/^upload-[a-z0-9-]+$/i.test(sessionToken) || !Number.isInteger(index) || !Number.isInteger(total)
        || total < 1 || total > 34 || index < 0 || index >= total || !request.file) {
        return response.status(400).json({ error: "Invalid upload chunk." });
      }
      const now = new Date().toISOString();
      const open = db.prepare(
        "SELECT 1 FROM more_upload_sessions WHERE token = ? AND opened_at IS NOT NULL AND used_at IS NULL AND expires_at > ?",
      ).get(sessionToken, now);
      if (!open) return response.status(404).json({ error: "This upload link has expired. Use /more in Discord for a new one." });
      try {
        await fs.promises.mkdir(partsDirectory, { recursive: true });
        await fs.promises.writeFile(path.join(partsDirectory, `${sessionToken}-${index}.part`), request.file.buffer);
        if (index < total - 1) return response.json({ complete: false, index });

        const buffer = await assembleMoreChunks(sessionToken, total);
        if (buffer.length > MAX_MORE_FILE_SIZE) {
          return response.status(413).json({ error: "That image is larger than the 100 MB limit." });
        }
        const contentType = String(request.body?.contentType || "");
        if (!isValidImageBuffer(buffer, contentType)) {
          return response.status(400).json({ error: "The file contents do not match a supported image type." });
        }
        const consumed = db.prepare(
          `UPDATE more_upload_sessions SET used_at = ?
           WHERE token = ? AND opened_at IS NOT NULL AND used_at IS NULL AND expires_at > ?
           RETURNING owner_id`,
        ).get(now, sessionToken, now);
        if (!consumed) return response.status(404).json({ error: "This upload link has expired. Use /more in Discord for a new one." });
        const id = crypto.randomUUID();
        const originalName = String(request.body?.filename || "image").slice(0, 500);
        db.prepare(
          `INSERT INTO hosted_images
            (id, owner_id, original_name, content_type, size_bytes, data, created_at, slug)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, consumed.owner_id, originalName, contentType, buffer.length, buffer, new Date().toISOString(), id);
        return response.status(201).json({ id, name: originalName, size: buffer.length, url: `/image/${id}` });
      } catch (chunkError) {
        console.error("Chunked upload failed:", chunkError);
        return response.status(400).json({ error: chunkError.message || "Upload failed." });
      }
    });
  }
  moreUpload.single("image")(request, response, async (error) => {
    if (error) {
      if (error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ error: "That image is larger than the 100 MB limit." });
      return response.status(400).json({ error: error.message || "Upload failed." });
    }
    if (!request.file) return response.status(400).json({ error: "Choose an image to upload." });
    if (!isValidImageBuffer(request.file.buffer, request.file.mimetype)) {
      return response.status(400).json({ error: "The file contents do not match a supported image type." });
    }
    const id = crypto.randomUUID();
    try {
      const now = new Date().toISOString();
      const session = db.prepare(
        `UPDATE more_upload_sessions SET used_at = ?
         WHERE token = ? AND opened_at IS NOT NULL AND used_at IS NULL AND expires_at > ?
         RETURNING owner_id`,
      ).get(now, String(request.body?.session || ""), now);
      if (!session) return response.status(404).json({ error: "This upload link has expired. Use /more in Discord for a new one." });
      const ownerId = session.owner_id;
      const originalName = request.file.originalname.slice(0, 500);
      db.prepare(
        `INSERT INTO hosted_images
          (id, owner_id, original_name, content_type, size_bytes, data, created_at, slug)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, ownerId, originalName, request.file.mimetype, request.file.size, request.file.buffer, new Date().toISOString(), id);
      response.status(201).json({ id, name: originalName, size: request.file.size, url: `/image/${id}` });
    } catch (dbError) {
      console.error("Could not save larger upload:", dbError);
      response.status(500).json({ error: "The image could not be saved. Please try again." });
    }
  });
});

app.post("/api/files", (request, response) => {
  archiveUpload.single("file")(request, response, async (error) => {
    if (error) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return response.status(413).json({ error: "That file is larger than the 70 MB limit." });
      }
      return response.status(400).json({ error: error.message || "File upload failed." });
    }
    if (!request.file) return response.status(400).json({ error: "Choose an archive file to upload." });

    const id = crypto.randomUUID();
    let slug;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = `host-p${String(crypto.randomInt(100, 1000))}`;
      if (!db.prepare("SELECT 1 FROM hosted_files WHERE slug = ?").get(candidate)
        && !db.prepare("SELECT 1 FROM hosted_images WHERE slug = ?").get(candidate)) {
        slug = candidate;
        break;
      }
    }
    if (!slug) {
      await fs.promises.rm(request.file.path, { force: true });
      return response.status(503).json({ error: "Could not create a unique file link. Try again." });
    }

    try {
      db.prepare(
        `INSERT INTO hosted_files
          (id, owner_id, original_name, content_type, size_bytes, stored_name, created_at, slug, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        "api",
        request.file.originalname.slice(0, 500),
        request.file.mimetype || "application/octet-stream",
        request.file.size,
        path.basename(request.file.filename),
        new Date().toISOString(),
        slug,
        await fs.promises.readFile(request.file.path),
      );
      // The database is the source of truth; do not keep a second full-size
      // archive copy on disk after the insert succeeds.
      await fs.promises.rm(request.file.path, { force: true });
      response.status(201).json({
        id,
        slug,
        name: request.file.originalname,
        size: request.file.size,
        url: `/file/${slug}`,
      });
    } catch (dbError) {
      await fs.promises.rm(request.file.path, { force: true });
      console.error("Could not save file metadata:", dbError);
      response.status(500).json({ error: "The file could not be saved. Please try again." });
    }
  });
});

async function serveImage(request, response) {
  const id = String(request.params.id || "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) return response.status(400).send("Invalid image ID");

  try {
     const image = db.prepare(
      `SELECT content_type, original_name, size_bytes, data
       FROM hosted_images WHERE id = ? OR slug = ?
       ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END LIMIT 1`,
    ).get(id, id, id);
    if (!image) return response.status(404).send("Image not found");
     db.prepare("UPDATE hosted_images SET view_count = view_count + 1 WHERE id = ? OR slug = ?").run(id, id);
    response.setHeader("Content-Type", image.content_type);
    response.setHeader("Content-Length", String(image.size_bytes));
    response.setHeader("Content-Disposition", `inline; filename="${image.original_name.replace(/["\r\n]/g, "")}"`);
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD") return response.end();
    response.end(image.data);
  } catch (error) {
    console.error("Image read failed:", error);
    response.status(500).send("Image unavailable");
  }
}

app.get("/image/:id", serveImage);
app.head("/image/:id", serveImage);

async function serveFile(request, response) {
  const slug = String(request.params.slug || "");
  if (!/^host-p[0-9]{3}$/i.test(slug)) return response.status(400).send("Invalid file ID");
  try {
    const file = db.prepare(
      "SELECT content_type, original_name, size_bytes, stored_name, data FROM hosted_files WHERE slug = ?",
    ).get(slug);
    if (!file) return response.status(404).send("File not found");
    const filePath = path.join(fileDirectory, path.basename(file.stored_name));
    if (!file.data && !fs.existsSync(filePath)) return response.status(404).send("File data not found");
    response.setHeader("Content-Type", file.content_type || "application/octet-stream");
    response.setHeader("Content-Length", String(file.size_bytes));
    response.setHeader("Content-Disposition", `attachment; filename="${file.original_name.replace(/["\r\n]/g, "")}"`);
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD") return response.end();
    if (file.data) return response.end(file.data);
    response.sendFile(filePath);
  } catch (error) {
    console.error("File read failed:", error);
    response.status(500).send("File unavailable");
        
