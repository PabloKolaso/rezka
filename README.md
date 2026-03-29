# HDRezka Stremio Addon

A community Stremio addon that provides movie and TV series streams from [HDRezka](https://rezka.ag) with multiple translation/dubbing options per title.

## Features

- **Movies & TV Series** — stream any content available on HDRezka via its IMDB ID
- **Multiple Translations** — choose from dozens of dubbing and subtitle options (Russian, Ukrainian, original audio, etc.)
- **Quality Selection** — automatic best-quality preference (1080p > 720p) with all options exposed
- **Smart Caching** — three-tier caching system (in-memory, disk persistence, TTL-based) for fast response times
- **HLS & MP4 Support** — transparent proxy handles CDN authentication and HLS manifest rewriting
- **Zero Configuration** — works out of the box with sensible defaults

## Architecture

```
Stremio Player
    │
    ▼
┌──────────────────────────┐
│     Express Server       │  ← /manifest.json, /stream/:type/:id, /proxy/stream
├──────────────────────────┤
│     Stream Handler       │  ← Parses IMDB IDs, selects translators, builds streams
├──────────┬───────────────┤
│ Resolver │   Rezka API   │  ← IMDB → HDRezka ID mapping + stream URL extraction
├──────────┴───────────────┤
│       Cinemeta           │  ← Fetches title metadata from Stremio's service
└──────────────────────────┘
    │
    ▼
HDRezka (rezka.ag)
```

### How It Works

1. **Request** — Stremio sends a stream request with an IMDB ID (e.g. `tt0944947`)
2. **Resolution** — The addon resolves the IMDB ID to an HDRezka content ID by fetching the title from Cinemeta, searching HDRezka, and matching by title + year
3. **Stream Extraction** — Fetches available streams from HDRezka's AJAX API for each translator, parsing quality variants (360p–1080p)
4. **Proxy** — Stream URLs are wrapped through a local proxy that injects the required `Referer` header and rewrites HLS manifests so Stremio can play them directly
5. **Response** — Formatted stream objects are returned to Stremio with translator name and quality labels

### Why the Proxy?

HDRezka uses Voidboost CDN which validates the `Referer` header on every request. Since Stremio's player sends requests without a Referer, direct URLs would fail. The `/proxy/stream` endpoint transparently adds the required headers and rewrites HLS manifest segment URLs to route through the proxy as well.

## Project Structure

```
src/
├── index.js              # Express server, proxy endpoint, lifecycle management
├── manifest.js           # Stremio addon manifest (ID, supported types, resources)
├── api/
│   ├── rezka.js          # HDRezka scraper & AJAX client (search, content info, streams)
│   └── cinemeta.js       # Stremio Cinemeta metadata service client
├── handlers/
│   └── streams.js        # Stream request handler (translator selection, quality filtering)
└── bridge/
    └── resolver.js       # IMDB → HDRezka ID resolver with dual-layer caching
data/
└── resolver-cache.json   # Persisted resolution cache (survives restarts)
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Stremio](https://www.stremio.com/) desktop or mobile app

### Installation

```bash
git clone https://github.com/your-username/stremio-rezka-addon.git
cd stremio-rezka-addon
npm install
```

### Running

```bash
# Production
npm start

# Development (auto-reload on file changes)
npm run dev
```

The server starts on port **7000** by default.

### Adding to Stremio

1. Start the addon server
2. Open Stremio and go to **Add-ons**
3. Click **Install from URL**
4. Enter: `http://localhost:7000/manifest.json`
5. Click **Install**

HDRezka streams will now appear when browsing movies and series.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7000` | Server listening port |
| `PUBLIC_URL` | — | Public URL for deployed instances (enables keep-alive pings) |

### Deployment Example

```bash
PUBLIC_URL=https://my-addon.example.com PORT=7000 npm start
```

When `PUBLIC_URL` is set, the addon pings itself every 12 minutes to prevent free-tier hosting platforms from suspending the process.

## Technical Details

### Caching Strategy

| Layer | TTL | Scope |
|-------|-----|-------|
| In-memory (searches) | 1 hour | HDRezka search results |
| In-memory (streams) | 15 minutes | Extracted stream URLs |
| In-memory (resolutions) | 24 hours | IMDB → HDRezka ID mappings |
| Disk persistence | Survives restarts | Resolution cache (`data/resolver-cache.json`) |

The disk cache auto-flushes every 5 seconds when new entries are added and on graceful shutdown.

### Session Management

HDRezka requires session cookies and a `favs` token for AJAX requests. The addon maintains per-content sessions, automatically refreshing them when they expire. For TV series, a season "warm-up" request is issued when accessing seasons beyond the first.

### Rate Limiting

To avoid being blocked, translator streams are fetched sequentially rather than in parallel. The addon processes up to 5 free translators per request, falling back to the first 3 available translators if no free ones are found.

## Dependencies

| Package | Purpose |
|---------|---------|
| [express](https://expressjs.com/) | HTTP server framework |
| [stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk) | Stremio protocol & routing |
| [axios](https://axios-http.com/) | HTTP client for API calls & scraping |
| [node-cache](https://github.com/node-cache/node-cache) | In-memory TTL-based caching |
| [cors](https://github.com/expressjs/cors) | Cross-origin resource sharing |
| [compression](https://github.com/expressjs/compression) | Response gzip compression |

## License

MIT
