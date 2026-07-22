export async function handler(event, context) {
  const fileId = event.queryStringParameters.id;
  const token = event.queryStringParameters.token;

  if (!fileId) {
    return {
      statusCode: 400,
      body: 'Missing Google Drive file ID',
    };
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (event.headers.range) {
    headers['Range'] = event.headers.range;
  }

  try {
    const driveRes = await fetch(driveUrl, { headers });

    if (!driveRes.ok && driveRes.status !== 206) {
      return {
        statusCode: driveRes.status,
        body: `Google Drive API error: ${driveRes.statusText}`,
      };
    }

    const contentType = driveRes.headers.get('content-type') || 'audio/mpeg';
    const contentLength = driveRes.headers.get('content-length');
    const contentRange = driveRes.headers.get('content-range');
    const acceptRanges = driveRes.headers.get('accept-ranges') || 'bytes';

    const arrayBuffer = await driveRes.arrayBuffer();
    const base64Body = Buffer.from(arrayBuffer).toString('base64');

    const responseHeaders = {
      'Content-Type': contentType,
      'Accept-Ranges': acceptRanges,
      'Access-Control-Allow-Origin': '*',
    };

    if (contentLength) responseHeaders['Content-Length'] = contentLength;
    if (contentRange) responseHeaders['Content-Range'] = contentRange;

    return {
      statusCode: driveRes.status,
      headers: responseHeaders,
      body: base64Body,
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('Error in Netlify media streaming proxy:', err);
    return {
      statusCode: 500,
      body: 'Internal Server Error during media streaming',
    };
  }
}
