/**
 * Stremio HDRezka Addon — Entry Point
 */

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const compression = require('compression');

const manifest           = require('./manifest');
const { streamHandler }  = require('./handlers/streams');
const { loadPersistedCache, flushToDisk } = require('./bridge/resolver');

const PORT = process.env.PORT || 7000;

// ─── Crash guards ─────────────────────────────────────────────────────────────
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', reason => {
  console.error('[unhandledRejection]', reason);
});

async function start() {
  const host = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

  // Build the addon
  const builder = new addonBuilder(manifest);
  builder.defineStreamHandler(streamHandler);

  console.log('=== Stremio HDRezka Addon ===');

  // Restore resolver cache from previous run
  loadPersistedCache();

  // HTTP server
  const addonInterface = builder.getInterface();
  const app = express();
  app.set('trust proxy', true);
  app.use(cors());
  app.use(compression());

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // ─── Stream proxy ──────────────────────────────────────────────────────────
  // Voidboost CDN validates the Referer header against the token's allowed origin.
  // Stremio's player requests streams directly (no Referer), so they are rejected.
  // This proxy adds the required headers and rewrites HLS manifest URLs so that
  // segment requests also pass through the proxy with the correct Referer.
  app.get('/proxy/stream', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).end();

    const reqHeaders = {
      'Referer': 'https://rezka.ag/',
      'Origin': 'https://rezka.ag',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    // Forward Range for MP4 seeking
    if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];

    try {
      const upstream = await axios({ method: 'GET', url, headers: reqHeaders, responseType: 'stream', timeout: 30_000, maxRedirects: 5 });

      const contentType = upstream.headers['content-type'] || '';
      const isM3U8 = url.includes('.m3u8') || contentType.toLowerCase().includes('mpegurl');

      if (upstream.status >= 400) {
        console.warn(`[proxy] Upstream returned HTTP ${upstream.status} for url: ${url}`);
      }

      res.setHeader('Access-Control-Allow-Origin', '*');

      if (isM3U8) {
        let text = '';
        upstream.data.on('data', chunk => { text += chunk.toString('utf8'); });
        upstream.data.on('end', () => {
          const addonBase = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
          const rewritten = text.split('\n').map(line => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return line;
            const abs = t.startsWith('http') ? t : new URL(t, url).href;
            return `${addonBase}/proxy/stream?url=${encodeURIComponent(abs)}`;
          }).join('\n');
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.send(rewritten);
        });
        upstream.data.on('error', () => { if (!res.headersSent) res.status(502).end(); });
      } else {
        res.status(upstream.status);
        if (upstream.headers['content-type'])   res.setHeader('Content-Type',   upstream.headers['content-type']);
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        if (upstream.headers['content-range'])  res.setHeader('Content-Range',  upstream.headers['content-range']);
        if (upstream.headers['accept-ranges'])  res.setHeader('Accept-Ranges',  upstream.headers['accept-ranges']);
        upstream.data.pipe(res);
      }
    } catch (err) {
      console.warn(`[proxy] ${err.message} | code: ${err.code || 'N/A'} | status: ${err.response?.status || 'N/A'} — url: ${url}`);
      if (!res.headersSent) res.status(502).end();
    }
  });

  app.use('/', getRouter(addonInterface));

  const server = app.listen(PORT);

  console.log(`\nAddon running at: ${host}/manifest.json`);
  console.log(`Health check:     ${host}/health`);
  console.log('Install in Stremio by opening the manifest URL above.\n');

  // Keep-alive ping for free hosting tiers
  let pingTimer = null;
  if (process.env.PUBLIC_URL) {
    pingTimer = setInterval(() => {
      axios.get(`${process.env.PUBLIC_URL}/health`)
        .then(() => console.log('[keepalive] Ping OK'))
        .catch(err => console.warn('[keepalive] Ping failed:', err.message));
    }, 12 * 60 * 1000);
    console.log('[keepalive] Self-ping enabled (every 12 min)');
  }

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[shutdown] SIGTERM received, closing server...');
    if (pingTimer) clearInterval(pingTimer);
    flushToDisk();
    server.close(() => {
      console.log('[shutdown] Server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000);
  });
}

start().catch(err => {
  console.error('[boot] Fatal startup error:', err);
  process.exit(1);
});
