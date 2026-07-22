export default async (req, context) => {
  const url = new URL(req.url);
  const fileId = url.searchParams.get("id");
  let token = url.searchParams.get("token");

  if (!fileId) {
    return new Response("Missing Google Drive file ID", { status: 400 });
  }

  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Forward Range header from client for audio/video seeking/scrubbing
  const range = req.headers.get("range");
  if (range) {
    headers["Range"] = range;
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  try {
    let driveRes = await fetch(driveUrl, { headers });

    // Fallback if token is expired, missing, or unauthorized on public/shared files
    if (!driveRes.ok && (driveRes.status === 401 || driveRes.status === 403 || driveRes.status === 404)) {
      const fallbackUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
      const fallbackRes = await fetch(fallbackUrl, {
        headers: range ? { Range: range } : {}
      });
      if (fallbackRes.ok || fallbackRes.status === 206) {
        driveRes = fallbackRes;
      }
    }

    if (!driveRes.ok && driveRes.status !== 206) {
      return new Response(`Google Drive error: ${driveRes.statusText}`, {
        status: driveRes.status,
      });
    }

    const contentType = driveRes.headers.get("content-type") || "audio/mpeg";
    const contentLength = driveRes.headers.get("content-length");
    const contentRange = driveRes.headers.get("content-range");
    const acceptRanges = driveRes.headers.get("accept-ranges") || "bytes";

    const responseHeaders = new Headers({
      "Content-Type": contentType,
      "Accept-Ranges": acceptRanges,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600"
    });

    if (contentLength) responseHeaders.set("Content-Length", contentLength);
    if (contentRange) responseHeaders.set("Content-Range", contentRange);

    // Return ReadableStream directly for immediate streaming pipe (0ms delay, no 10s timeout)
    return new Response(driveRes.body, {
      status: driveRes.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("Error in Netlify media streaming proxy:", err);
    return new Response("Internal Server Error during media streaming", { status: 500 });
  }
};
