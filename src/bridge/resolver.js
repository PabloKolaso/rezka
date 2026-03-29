/**
 * IMDB → HDRezka Content Resolver
 *
 * Resolves a Stremio IMDB ID to a HDRezka content ID + translator list.
 *
 * Resolution pipeline:
 *  1. Check in-memory + disk cache
 *  2. Fetch title from Cinemeta
 *  3. Search HDRezka by title
 *  4. Best match: prefer exact title + year match, fallback to first result
 *  5. Scrape content page for internal ID and translators
 */

const fs   = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

const cinemeta = require('../api/cinemeta');
const rezka    = require('../api/rezka');

const CACHE_FILE = path.resolve(__dirname, '../../data/resolver-cache.json');

// In-memory cache: imdbId → { id, translators, title, url } | null
// null = confirmed not found, cached for 2h to avoid hammering
const resolvedMap = new NodeCache({ stdTTL: 86400, checkperiod: 600 });

// ─── Disk persistence ─────────────────────────────────────────────────────────

function loadPersistedCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0;
    for (const [key, entry] of Object.entries(data)) {
      if (!entry) continue;
      const { value, expiresAt } = entry;
      if (expiresAt && expiresAt < now) continue;
      const ttl = expiresAt ? Math.max(60, Math.round((expiresAt - now) / 1000)) : 86400;
      resolvedMap.set(key, value !== undefined ? value : null, ttl);
      loaded++;
    }
    if (loaded > 0) console.log(`[resolver] Loaded ${loaded} cached resolutions from disk.`);
  } catch (err) {
    console.warn('[resolver] Failed to load persisted cache:', err.message, '\n', err.stack);
  }
}

function flushToDisk() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const keys = resolvedMap.keys();
    const out = {};
    for (const key of keys) {
      const value     = resolvedMap.get(key);
      const expiresAt = resolvedMap.getTtl(key);
      out[key] = { value: value !== undefined ? value : null, expiresAt: expiresAt || 0 };
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out));
  } catch (err) {
    console.warn('[resolver] Failed to flush cache to disk:', err.message, '\n', err.stack);
  }
}

let _flushTimer = null;
function scheduleFlush() {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => { flushToDisk(); _flushTimer = null; }, 5000);
}

// ─── Title matching ───────────────────────────────────────────────────────────

/** Normalize title for comparison: lowercase, strip punctuation */
function normalizeTitle(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the best matching result from a Rezka search.
 * Prefers exact title match (normalized), then year match, then first result.
 * When season > 1, prefers URLs containing "tv-{season}" (rezka puts each season
 * on a separate page, e.g. "tv-1", "tv-2", etc.).
 * @param {Array<{url, title, year, type}>} results
 * @param {string} title
 * @param {number|null} year
 * @param {number|null} [season]
 * @returns {{ url: string, title: string }|null}
 */
function pickBestMatch(results, title, year, season) {
  if (!results || results.length === 0) return null;

  const normQuery = normalizeTitle(title);

  // For season > 1, try to find a season-specific page first (e.g. URL contains "tv-2")
  if (season && season > 1) {
    const seasonTag = `tv-${season}`;
    const seasonResults = results.filter(r => r.url.includes(seasonTag));
    if (seasonResults.length > 0) {
      if (year) {
        const m = seasonResults.find(r => normalizeTitle(r.title) === normQuery && r.year === String(year));
        if (m) return m;
      }
      const m = seasonResults.find(r => normalizeTitle(r.title) === normQuery)
             || seasonResults.find(r => normalizeTitle(r.title).startsWith(normQuery))
             || seasonResults[0];
      return m;
    }
  }

  // For season 1 (or unspecified), exclude pages explicitly tagged for a higher season.
  // Rezka puts each season on a separate page (tv-2, tv-3, …); season 1 is the base page.
  let pool = results;
  if (!season || season === 1) {
    const base = results.filter(r => !/[/-]tv-[2-9](\b|-)/.test(r.url) && !/[/-]tv-\d{2,}/.test(r.url));
    if (base.length > 0) pool = base;
  }

  // Try exact title + year match
  if (year) {
    const exact = pool.find(r =>
      normalizeTitle(r.title) === normQuery && r.year === String(year)
    );
    if (exact) return exact;
  }

  // Try exact title match (any year)
  const exactTitle = pool.find(r => normalizeTitle(r.title) === normQuery);
  if (exactTitle) return exactTitle;

  // Try starts-with match (handles "Title: Subtitle" vs "Title")
  const startsWith = pool.find(r => normalizeTitle(r.title).startsWith(normQuery));
  if (startsWith) return startsWith;

  // Fall back to first result from the filtered pool
  return pool[0];
}

// ─── Main resolution ──────────────────────────────────────────────────────────

/**
 * Resolve an IMDB ID to HDRezka content info.
 * @param {string} imdbId
 * @param {string} [type] - "movie" or "series"
 * @param {number|null} [season] - season number for series (enables per-season page resolution)
 * @returns {Promise<{ id: string|null, translators: Array, title: string|null, url: string|null }>}
 */
async function resolveImdbDetailed(imdbId, type, season) {
  // Season > 1 may be on a separate rezka page — cache per season to avoid stale season-1 entries
  const cacheKey = (season && season > 1) ? `${imdbId}:s${season}` : imdbId;

  // 1. Cache check
  const cached = resolvedMap.get(cacheKey);
  if (cached !== undefined) {
    return cached
      ? { id: cached.id, translators: cached.translators, title: cached.title, url: cached.url }
      : { id: null, translators: [], title: null, url: null };
  }

  // 2. Fetch title from Cinemeta
  let title = null;
  let year = null;
  try {
    const info = await cinemeta.fetchTitleInfo(imdbId, type);
    if (info) {
      title = info.title;
      year = info.year;
    }
  } catch (err) {
    console.warn(`[resolver] Cinemeta failed for ${imdbId}:`, err.message);
  }

  if (!title) {
    console.warn(`[resolver] No title found for ${imdbId}`);
    resolvedMap.set(cacheKey, null, 7200);
    scheduleFlush();
    return { id: null, translators: [], title: null, url: null };
  }

  console.log(`[resolver] Resolving ${imdbId} → "${title}" (${year || '?'})`);

  // 3. Search Rezka
  let searchResults = [];
  try {
    searchResults = await rezka.search(title);
  } catch (err) {
    console.warn(`[resolver] Rezka search failed for "${title}":`, err.message);
  }

  // If no results, try without year-like suffixes or parentheticals
  if (searchResults.length === 0) {
    const simplified = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (simplified !== title) {
      console.log(`[resolver] Retrying search with simplified title: "${simplified}"`);
      try {
        searchResults = await rezka.search(simplified);
      } catch (err) {
        console.warn(`[resolver] Retry search failed for simplified title "${simplified}": ${err.message}`);
      }
    }
  }

  const match = pickBestMatch(searchResults, title, year, season);
  if (!match) {
    console.warn(`[resolver] No Rezka match for "${title}" (${imdbId}) — searched ${searchResults.length} result(s)${searchResults.length > 0 ? ': ' + searchResults.map(r => `"${r.title}"(${r.year})`).join(', ') : ''}`);
    resolvedMap.set(cacheKey, null, 7200);
    scheduleFlush();
    return { id: null, translators: [], title, url: null };
  }

  console.log(`[resolver] Matched "${title}" → ${match.url}`);

  // 4. Scrape content page for ID and translators
  let contentInfo = null;
  try {
    contentInfo = await rezka.getContentInfo(match.url);
  } catch (err) {
    console.warn(`[resolver] Content info fetch failed for ${match.url}:`, err.message);
  }

  if (!contentInfo?.id) {
    console.warn(`[resolver] Could not get content ID for ${match.url}`);
    resolvedMap.set(cacheKey, null, 3600);
    scheduleFlush();
    return { id: null, translators: [], title, url: match.url };
  }

  const result = {
    id: contentInfo.id,
    translators: contentInfo.translators,
    title,
    url: match.url,
  };

  resolvedMap.set(cacheKey, result);
  scheduleFlush();
  return result;
}

module.exports = { resolveImdbDetailed, loadPersistedCache, flushToDisk };
