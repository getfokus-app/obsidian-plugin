/**
 * `multipart/form-data`, built by hand.
 *
 * Obsidian's `requestUrl` takes a string or an ArrayBuffer and does not accept
 * `FormData` — and `fetch`, which would, is unusable here because the renderer's
 * Origin is not on the backend's CORS allowlist. So the body is assembled byte
 * by byte.
 */
export interface FilePart {
  field: string;
  filename: string;
  contentType: string;
  data: ArrayBuffer;
}

export interface MultipartBody {
  contentType: string;
  body: ArrayBuffer;
}

/**
 * A boundary that cannot appear in the payload by accident.
 *
 * Random rather than fixed: a fixed boundary appearing inside an uploaded file
 * would split the body in the wrong place, and the failure would look like a
 * corrupt image rather than a framing bug.
 */
function newBoundary(): string {
  const random = Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0'),
  ).join('');
  return `----FokusSyncBoundary${random}`;
}

export function buildMultipart(
  fields: Record<string, string>,
  file: FilePart,
  boundary = newBoundary(),
): MultipartBody {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(name)}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  chunks.push(
    encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${escapeQuotes(file.field)}"; filename="${escapeQuotes(file.filename)}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  chunks.push(new Uint8Array(file.data));
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: body.buffer,
  };
}

/**
 * A quote or newline in a filename would end the header early and let the rest
 * be read as another header, so neither is allowed through.
 */
function escapeQuotes(value: string): string {
  return value.replace(/[\r\n]/g, ' ').replace(/"/g, "'");
}
