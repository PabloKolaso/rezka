/**
 * Cloudflare Worker — Transparent reverse proxy to hdrezka.ag
 *
 * Deploy this worker and set REZKA_BASE_URL in the addon to its URL.
 * All requests from the addon will route through Cloudflare IPs instead of
 * the addon host's IP, bypassing IP-based blocks on rezka.ag.
 *
 * Deploy:
 *   cd worker && npx wrangler deploy
 *
 * Then set in your addon environment:
 *   REZKA_BASE_URL=https://<your-worker-name>.<your-cf-subdomain>.workers.dev
 */

const TARGET_ORIGIN = 'https://hdrezka.ag';

// Headers managed by Cloudflare or irrelevant to the upstream — strip them
const DROP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': '*',
        },
      });
    }

    // Health check (separate path so '/' gets proxied to rezka.ag)
    if (url.pathname === '/_health') {
      return new Response('rezka-proxy OK', { status: 200 });
    }

    // Build upstream URL — same path + query string, targeting rezka
    const upstreamUrl = new URL(url.pathname + url.search, TARGET_ORIGIN);

    // Copy and sanitize request headers
    const upstreamHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (DROP_HEADERS.has(key.toLowerCase())) continue;

      // Rewrite Origin so rezka sees its own origin, not the worker URL
      if (key.toLowerCase() === 'origin') {
        upstreamHeaders.set('origin', TARGET_ORIGIN);
        continue;
      }

      // Rewrite Referer so rezka sees a valid same-site referer
      if (key.toLowerCase() === 'referer') {
        try {
          const refUrl = new URL(value);
          const target = new URL(TARGET_ORIGIN);
          refUrl.host = target.host;
          refUrl.protocol = target.protocol;
          upstreamHeaders.set('referer', refUrl.toString());
        } catch {
          upstreamHeaders.set('referer', TARGET_ORIGIN + '/');
        }
        continue;
      }

      upstreamHeaders.set(key, value);
    }

    upstreamHeaders.set('host', new URL(TARGET_ORIGIN).host);

    const upstreamRequest = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      redirect: 'follow',
    });

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamRequest);
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 502 });
    }

    // Copy response headers, strip hop-by-hop
    const responseHeaders = new Headers();
    for (const [key, value] of upstreamResponse.headers.entries()) {
      if (DROP_HEADERS.has(key.toLowerCase())) continue;
      responseHeaders.append(key, value);
    }
    responseHeaders.set('access-control-allow-origin', '*');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
