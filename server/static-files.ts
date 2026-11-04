// Serves the GUI client (plain ES modules — no bundler, since the server
// itself has no build step) out of a directory. Resolves the request path
// against that root and refuses anything that escapes it, so a path like
// `/../server/store.ts` can't read files outside the public directory.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  // Browsers refuse `<script type="module">` unless the response's
  // Content-Type is a JavaScript MIME type — "text/plain" or no header
  // fails silently with no console error pointing at this.
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

export interface StaticFile {
  status: 200;
  contentType: string;
  body: Buffer;
}

export function serveStatic(root: string, pathname: string): StaticFile | null {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const resolved = normalize(join(root, relative));
  if (!resolved.startsWith(normalize(root))) return null; // traversal attempt

  if (!existsSync(resolved) || !statSync(resolved).isFile()) return null;

  const contentType = MIME_TYPES[extname(resolved)];
  if (!contentType) return null; // only serve recognised static asset types

  return { status: 200, contentType, body: readFileSync(resolved) };
}
