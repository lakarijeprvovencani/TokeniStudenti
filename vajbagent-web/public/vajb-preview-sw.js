/**
 * VajbAgent Preview Service Worker
 *
 * In-browser "static server" for AI-generated sites. The preview iframe
 * loads pages from `/__vajb_preview/<sessionId>/...` and this worker
 * responds with file content published from the main page. This lets
 * AI-generated sites use native navigation (<a href="about.html">),
 * fetch(), <link href="style.css">, etc. — exactly as they'll behave
 * once deployed to Netlify.
 *
 * Why not blob: URLs? Blob URLs are a single-file origin. Any relative
 * navigation or fetch resolves against the blob path which has no
 * filesystem, producing "Not allowed to load local resource" errors
 * all over the console. A service-worker-backed same-origin virtual
 * path resolves everything cleanly.
 *
 * Security note: the preview iframe MUST be sandboxed (no
 * allow-same-origin) even though the URL is technically same-origin
 * with the main app. Otherwise AI-generated scripts could read the
 * host app's localStorage (api_key, etc.). The iframe runs with an
 * opaque origin despite the URL.
 */

/* eslint-disable no-restricted-globals */

const PREFIX = '/__vajb_preview/';
const sessions = new Map(); // sid → Record<path, string>

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  const reply = (data) => { try { if (event.ports && event.ports[0]) event.ports[0].postMessage(data); } catch {} };

  if (msg.type === 'vajb-publish') {
    if (typeof msg.sid === 'string' && msg.files && typeof msg.files === 'object') {
      sessions.set(msg.sid, msg.files);
      reply({ ok: true, count: Object.keys(msg.files).length });
    } else {
      reply({ ok: false, error: 'invalid payload' });
    }
  } else if (msg.type === 'vajb-clear') {
    sessions.delete(msg.sid);
    reply({ ok: true });
  } else if (msg.type === 'vajb-ping') {
    reply({ ok: true, sessions: sessions.size });
  }
});

function mimeFor(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'html': case 'htm': return 'text/html; charset=utf-8';
    case 'css': return 'text/css; charset=utf-8';
    case 'js': case 'mjs': case 'cjs': return 'application/javascript; charset=utf-8';
    case 'json': return 'application/json; charset=utf-8';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'ico': return 'image/x-icon';
    case 'avif': return 'image/avif';
    case 'woff': return 'font/woff';
    case 'woff2': return 'font/woff2';
    case 'ttf': return 'font/ttf';
    case 'otf': return 'font/otf';
    case 'eot': return 'application/vnd.ms-fontobject';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'txt': case 'md': return 'text/plain; charset=utf-8';
    case 'xml': return 'application/xml; charset=utf-8';
    case 'wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

function decodeDataUrl(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return { body: new Uint8Array(0), type: 'application/octet-stream' };
  const header = dataUrl.slice(5, commaIdx);
  const isBase64 = header.includes(';base64');
  const payload = dataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/^[^;]+/);
  const type = mimeMatch ? mimeMatch[0] : 'application/octet-stream';
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { body: bytes, type };
  }
  return { body: decodeURIComponent(payload), type };
}

function lookup(files, path) {
  if (!path) path = 'index.html';
  if (files[path] != null) return { key: path, content: files[path] };

  const clean = path.replace(/^\.?\//, '');
  if (files[clean] != null) return { key: clean, content: files[clean] };

  const leaf = clean.split('/').pop();
  if (leaf) {
    const keys = Object.keys(files);
    const byLeaf = keys.find(k => k === leaf || k.endsWith('/' + leaf));
    if (byLeaf) return { key: byLeaf, content: files[byLeaf] };

    // public/ is hoisted to root in Netlify/Vite deploys — mirror that
    const viaPublic = keys.find(k => k === 'public/' + clean || k.endsWith('/public/' + clean));
    if (viaPublic) return { key: viaPublic, content: files[viaPublic] };
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(PREFIX)) return;

  const rest = url.pathname.slice(PREFIX.length);
  const firstSlash = rest.indexOf('/');
  const sid = firstSlash < 0 ? rest : rest.slice(0, firstSlash);
  let path = firstSlash < 0 ? '' : rest.slice(firstSlash + 1);
  path = path.replace(/^\/+/, '');
  if (!path || path.endsWith('/')) path = (path || '') + 'index.html';

  event.respondWith((async () => {
    const files = sessions.get(sid);
    if (!files) {
      return new Response('Preview session not available. Try reloading.', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    let hit = lookup(files, path);
    // "/about" → try about.html, about/index.html
    if (!hit && !path.includes('.')) {
      hit = lookup(files, path + '.html') || lookup(files, path + '/index.html');
    }
    if (!hit) {
      if (/favicon\.ico$/.test(path)) {
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: {
            'Content-Type': 'image/x-icon',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      return new Response(`Not found in preview: /${path}`, {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const mime = mimeFor(hit.key);
    const content = hit.content;

    if (typeof content === 'string' && content.startsWith('data:')) {
      const decoded = decodeDataUrl(content);
      return new Response(decoded.body, {
        headers: {
          'Content-Type': decoded.type || mime,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (typeof content === 'string' && /^https?:\/\//.test(content)) {
      try {
        const upstream = await fetch(content, { credentials: 'omit' });
        const buf = await upstream.arrayBuffer();
        return new Response(buf, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('content-type') || mime,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch {
        return new Response('Upstream fetch failed', {
          status: 502,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    return new Response(content, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  })());
});
