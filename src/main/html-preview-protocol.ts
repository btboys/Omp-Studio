import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { protocol } from "electron";

const SCHEME = "pi-preview";
const MAX_SESSIONS = 64;

type PreviewSession = {
  root: string;
  createdAt: number;
};

const sessions = new Map<string, PreviewSession>();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export function registerHtmlPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function response(status: number, body: string | Buffer, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body as BodyInit, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pruneSessions(): void {
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
}

export function createHtmlPreviewUrl(absPath: string, requestedRoot?: string): string {
  const file = realpathSync(absPath);
  if (!statSync(file).isFile() || ![".html", ".htm"].includes(extname(file).toLowerCase())) {
    throw new Error("HTML preview requires an .html or .htm file");
  }

  let root = dirname(file);
  if (requestedRoot && existsSync(requestedRoot)) {
    const candidate = realpathSync(requestedRoot);
    if (statSync(candidate).isDirectory() && inside(candidate, file)) root = candidate;
  }

  pruneSessions();
  const token = randomUUID();
  sessions.set(token, { root, createdAt: Date.now() });
  const rel = relative(root, file)
    .split(sep)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${SCHEME}://${token}/${rel}?v=${statSync(file).mtimeMs}`;
}

export function registerHtmlPreviewProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return response(405, "Method not allowed");
      const url = new URL(request.url);
      const session = sessions.get(url.hostname);
      if (!session) return response(404, "Preview session expired");

      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "").replace(/\//g, sep);
      let target = resolve(session.root, rel);
      if (existsSync(target) && statSync(target).isDirectory()) target = resolve(target, "index.html");
      if (!existsSync(target)) return response(404, "Preview resource not found");

      const realTarget = realpathSync(target);
      if (!inside(session.root, realTarget)) return response(403, "Resource is outside the preview project");
      const type = MIME_TYPES[extname(realTarget).toLowerCase()];
      if (!type) return response(415, "Resource type is not available in HTML preview");

      const body = request.method === "HEAD" ? "" : readFileSync(realTarget);
      return response(200, body, type);
    } catch (error: any) {
      return response(400, error?.message || "Invalid preview request");
    }
  });
}
