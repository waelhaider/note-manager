import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Readable } from "stream";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Streaming Proxy endpoint for Google Drive audio files
  app.get("/api/stream", async (req, res) => {
    const fileId = req.query.id as string;
    const token = req.query.token as string;

    if (!fileId || !token) {
      res.status(400).send("Missing Google Drive file ID or Access Token");
      return;
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${token}`
    };

    // Forward Range header from client if present to support scrubbing/seeking
    if (req.headers.range) {
      headers["Range"] = req.headers.range;
    }

    try {
      const driveRes = await fetch(driveUrl, { headers });

      // Handle common authentication or fetch errors
      if (!driveRes.ok && driveRes.status !== 206) {
        console.error(`Google Drive API error: ${driveRes.status} ${driveRes.statusText}`);
        res.status(driveRes.status).send(`Google Drive API error: ${driveRes.statusText}`);
        return;
      }

      // Forward relevant headers to client
      const contentType = driveRes.headers.get("content-type") || "audio/mpeg";
      const contentLength = driveRes.headers.get("content-length");
      const contentRange = driveRes.headers.get("content-range");
      const acceptRanges = driveRes.headers.get("accept-ranges") || "bytes";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Accept-Ranges", acceptRanges);

      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }
      if (contentRange) {
        res.setHeader("Content-Range", contentRange);
      }

      // Respond with the appropriate status code (200 OK or 206 Partial Content)
      res.status(driveRes.status);

      if (driveRes.body) {
        const nodeStream = Readable.fromWeb(driveRes.body as any);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      console.error("Error in streaming proxy:", err);
      res.status(500).send("Internal Server Error during media streaming");
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
