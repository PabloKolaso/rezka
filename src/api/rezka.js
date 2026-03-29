/**
 * HDRezka API Client
 *
 * Communicates with rezka.ag via:
 *  1. HTML search to find content by title
 *  2. Content page scrape to get internal ID + translator list
 *  3. AJAX endpoint to get stream URLs per translator/episode
 */

const axios = require('axios');
const NodeCache = require('node-cache');

const BASE = 'https://rezka.ag';

const cache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

// Session cookies + content URL saved per content ID — required for AJAX requests
const sessionStore = new Map(); // contentId → { cookies: string, pageUrl: string }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ─── URL parsing ──────────────────────────────────────────────────────────────

/**
 * Parse HDRezka stream URL string into a quality → URL map.
 *
 * Format: "[360p]url1,url2 or [480p]url1,url2:hls:hls_url or [720p]url1 or [1080p]url1"
 * Some entries have ":hls:HLSURL" appended — prefer HLS when present.
 *
 * @param {string} urlStr
 * @returns {{ [quality: string]: string }}
 */
function parseStreamQualities(urlStr) {
  if (!urlStr || !urlStr.trim()) {
    console.warn('[rezka] parseStreamQualities: received empty/null URL string');
    return {};
  }
  const result = {};
  // Format: "[360p]url1 or url2,[480p]url3 or url4,..."
  // Split on commas that precede a quality tag to separate blocks per quality.
  const blocks = urlStr.split(/,(?=\[)/);

  for (const block of blocks) {
    const bracketMatch = block.match(/^\[([^\]]+)\](.+)$/s);
    if (!bracketMatch) continue;

    const quality = bracketMatch[1].trim();
    const urlsPart = bracketMatch[2].trim();

    // Within a block, alternative CDN URLs are separated by ' or '
    const urls = urlsPart.split(' or ').map(u => u.trim()).filter(Boolean);

    let bestUrl = null;
    let directMp4 = null;
    for (const u of urls) {
      if (u.includes(':hls:')) {
        const colonHlsIdx = u.indexOf(':hls:');
        const mp4Url = u.substring(0, colonHlsIdx);
        const hlsPart = u.substring(colonHlsIdx + 5); // after ':hls:'
        directMp4 = mp4Url;
        if (hlsPart.startsWith('http')) {
          // Absolute HLS manifest URL — use it directly
          bestUrl = hlsPart;
        } else {
          // Relative manifest (e.g. "manifest.m3u8") — voidboost signs each file individually,
          // so the MP4 hash is NOT valid for the manifest URL. Use the direct MP4 instead.
          console.log(`[rezka] Relative HLS manifest detected ("${hlsPart}"), using direct MP4 URL to avoid CDN 404`);
          bestUrl = mp4Url;
        }
        break;
      }
    }
    if (!bestUrl) bestUrl = urls[urls.length - 1];

    if (quality && bestUrl) {
      result[quality] = bestUrl;
      // Also expose the direct MP4 as a fallback (picked up by the extra-qualities path)
      if (directMp4 && directMp4 !== bestUrl) {
        result[`${quality} MP4`] = directMp4;
      }
    }
  }
  if (Object.keys(result).length === 0) {
    console.warn('[rezka] parseStreamQualities: no quality blocks extracted. Raw input (first 300):', urlStr.slice(0, 300));
  }
  return result;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Search HDRezka for content by title.
 * @param {string} title
 * @returns {Promise<Array<{ url: string, title: string, year: string|null, type: string }>>}
 */
async function search(title) {
  const cacheKey = `search:${title.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE}/search/?do=search&subaction=search&q=${encodeURIComponent(title)}`;
  let html;
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 10_000 });
    html = data;
  } catch (err) {
    console.warn(`[rezka] Search failed for "${title}": ${err.message} | code: ${err.code || 'N/A'} | status: ${err.response?.status || 'N/A'}`);
    return [];
  }

  const results = [];

  // Match each search result block: <div class="b-content__inline_item" data-url="...">
  const itemRe = /<div[^>]+class="b-content__inline_item"[^>]+data-url="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let match;
  while ((match = itemRe.exec(html)) !== null) {
    const itemUrl = match[1];
    const itemHtml = match[2];

    const titleMatch = itemHtml.match(/<span\s+class="title"[^>]*>([^<]+)<\/span>/i)
      || itemHtml.match(/<b[^>]*>([^<]+)<\/b>/i);
    if (!titleMatch) console.warn(`[rezka] Could not extract title from search result item (url: ${itemUrl})`);
    const itemTitle = titleMatch ? titleMatch[1].trim() : '';

    const yearMatch = itemHtml.match(/<span\s+class="year"[^>]*>(\d{4})/i)
      || itemHtml.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[1] : null;

    let type = 'movie';
    if (itemUrl.includes('/series/')) type = 'series';
    else if (itemUrl.includes('/cartoons/')) type = 'cartoon';
    else if (itemUrl.includes('/animation/')) type = 'animation';
    else if (itemUrl.includes('/anime/')) type = 'anime';

    if (itemUrl && itemTitle) {
      results.push({ url: itemUrl, title: itemTitle, year, type });
    }
  }

  if (results.length === 0) {
    console.warn(`[rezka] Search returned 0 results for "${title}" (url=${url})`);
  } else {
    console.log(`[rezka] Search found ${results.length} result(s) for "${title}":`, results.map(r => `"${r.title}"(${r.year})`).join(', '));
  }

  cache.set(cacheKey, results);
  return results;
}

// ─── Content page scrape ──────────────────────────────────────────────────────

/**
 * Scrape a HDRezka content page to extract internal ID and translator list.
 * Also saves session cookies for subsequent AJAX calls.
 * @param {string} contentUrl
 * @returns {Promise<{ id: string, translators: Array<{ id: string, name: string, isPremium: boolean }> }|null>}
 */
async function getContentInfo(contentUrl) {
  const cacheKey = `info:${contentUrl}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let html, responseCookies;
  try {
    const response = await axios.get(contentUrl, { headers: HEADERS, timeout: 10_000 });
    console.log(`[rezka] Content page fetch: status=${response.status} url=${contentUrl}`);
    html = response.data;
    // Save session cookies — required by the AJAX endpoint
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      responseCookies = setCookie.map(c => c.split(';')[0]).join('; ');
    } else {
      console.warn(`[rezka] No Set-Cookie header from content page — AJAX requests may fail (url=${contentUrl})`);
    }
  } catch (err) {
    console.error(`[rezka] Content page fetch failed for ${contentUrl}: ${err.message} | code: ${err.code || 'N/A'} | status: ${err.response?.status || 'N/A'}`);
    return null;
  }

  // Extract internal content ID
  const idMatch = html.match(/initCDNSeriesEvents\((\d+),/)
    || html.match(/initCDNMoviesEvents\((\d+),/)
    || html.match(/id="player"[^>]*data-id="(\d+)"/i)
    || html.match(/data-id="(\d+)"/);

  const contentId = idMatch ? idMatch[1] : null;
  if (!contentId) {
    console.warn(`[rezka] Could not extract content ID from ${contentUrl}`);
    console.warn(`[rezka] HTML snippet (first 500 chars):`, html.slice(0, 500));
    return null;
  }

  // Extract favs token — required by the AJAX endpoint
  const favsMatch = html.match(/id="ctrl_favs"\s+value="([^"]+)"/);
  const favs = favsMatch ? favsMatch[1] : '';

  // Save cookies + page URL + favs token keyed by content ID
  sessionStore.set(contentId, { cookies: responseCookies || '', pageUrl: contentUrl, favs });

  // Extract translators
  const translators = [];
  const transRe = /<li[^>]+class="[^"]*b-translator__item[^"]*"[^>]+data-translator_id="(\d+)"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = transRe.exec(html)) !== null) {
    const transId = m[1];
    const transName = m[2].replace(/<[^>]+>/g, '').trim();
    // Check for data-premium attribute
    const isPremium = /data-premium="1"/.test(m[0]);
    if (transId && transName) {
      translators.push({ id: transId, name: transName, isPremium });
    }
  }

  // Fallback: extract default translator from JS init call
  if (translators.length === 0) {
    const defaultTrans = html.match(/initCDN(?:Movies|Series)Events\(\d+,\s*(\d+),/);
    if (defaultTrans) {
      translators.push({ id: defaultTrans[1], name: 'Default', isPremium: false });
    }
  }

  console.log(`[rezka] Content ${contentId}: ${translators.length} translator(s):`, translators.map(t => `${t.name}(${t.id})`).join(', '));

  const result = { id: contentId, translators };
  cache.set(cacheKey, result);
  return result;
}

// ─── Stream fetching ──────────────────────────────────────────────────────────

/**
 * Re-fetch the content page to get fresh session cookies.
 * Called automatically when the AJAX endpoint returns a session-expired error.
 */
async function refreshSessionCookies(contentId) {
  const session = sessionStore.get(contentId);
  if (!session?.pageUrl) return;
  try {
    const response = await axios.get(session.pageUrl, { headers: HEADERS, timeout: 10_000 });
    const html = response.data;
    const setCookie = response.headers['set-cookie'];
    const freshCookies = setCookie
      ? setCookie.map(c => c.split(';')[0]).join('; ')
      : session.cookies;
    const favsMatch = html.match(/id="ctrl_favs"\s+value="([^"]+)"/);
    const freshFavs = favsMatch ? favsMatch[1] : '';
    sessionStore.set(contentId, { ...session, cookies: freshCookies, favs: freshFavs });
    console.log(`[rezka] Session refreshed for content ${contentId}`);
  } catch (err) {
    console.warn(`[rezka] Session refresh failed for ${contentId}:`, err.message);
  }
}

function buildAjaxHeaders(contentId) {
  const session = sessionStore.get(contentId);
  const referer = session?.pageUrl || `${BASE}/`;
  const cookies = session?.cookies || '';
  return {
    'User-Agent': HEADERS['User-Agent'],
    'Accept-Language': HEADERS['Accept-Language'],
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': referer,
    'Origin': BASE,
    ...(cookies ? { 'Cookie': cookies } : {}),
  };
}

/**
 * Ensure sessionStore has an entry for contentId so refreshSessionCookies can work.
 * Call this whenever you know the pageUrl (e.g. from the resolver result) but
 * getContentInfo may not have been called yet (disk-cache fast path).
 */
function initSession(contentId, pageUrl) {
  if (!sessionStore.has(contentId)) {
    sessionStore.set(contentId, { cookies: '', pageUrl, favs: '' });
  }
}

/**
 * Warm up the server-side session for a given season by requesting its episode list.
 * Required for seasons > 1 — the content page only initializes season 1 by default.
 */
async function warmUpSeason(contentId, translatorId, season) {
  try {
    const session = sessionStore.get(contentId);
    const params = new URLSearchParams({
      id: contentId,
      translator_id: translatorId,
      season: String(season),
      favs: session?.favs || '',
      action: 'get_episodes',
    });
    const response = await axios.post(
      `${BASE}/ajax/get_cdn_series/?t=${Date.now()}`,
      params.toString(),
      { headers: buildAjaxHeaders(contentId), timeout: 10_000 }
    );
    const { data } = response;

    // Capture any new cookies set by the warm-up response and update the session store
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      const freshCookies = setCookie.map(c => c.split(';')[0]).join('; ');
      const currentSession = sessionStore.get(contentId);
      if (currentSession) {
        sessionStore.set(contentId, { ...currentSession, cookies: freshCookies });
      }
    }

    if (data?.success === false) {
      console.log(`[rezka] Warm-up s${season} for ${contentId}: ${data.message}`);
    } else {
      console.log(`[rezka] Warm-up s${season} for ${contentId}: OK`);
    }
  } catch (err) {
    console.log(`[rezka] Warm-up s${season} for ${contentId} failed: ${err.message}`);
  }
}

/**
 * Fetch stream URLs for a series episode.
 */
async function getSeriesStreams(contentId, translatorId, season, episode) {
  const cacheKey = `streams:series:${contentId}:${translatorId}:${season}:${episode}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    // Season 1 is initialized by the content page; higher seasons need a warm-up call first.
    if (season > 1) {
      await warmUpSeason(contentId, translatorId, season);
    }

    const session = sessionStore.get(contentId);
    const params = new URLSearchParams({
      id: contentId,
      translator_id: translatorId,
      season: String(season),
      episode: String(episode),
      favs: session?.favs || '',
      action: 'get_stream',
    });

    let { data } = await axios.post(
      `${BASE}/ajax/get_cdn_series/?t=${Date.now()}`,
      params.toString(),
      { headers: buildAjaxHeaders(contentId), timeout: 10_000 }
    );

    // Log non-success AJAX responses for diagnostics
    if (data?.success === false) {
      console.warn(`[rezka] AJAX error (series s${season}e${episode} id=${contentId} tr=${translatorId}): success=false, message="${data.message || 'N/A'}"`);
    }

    // Session expired — refresh cookies + favs token, re-warm season, and retry once
    if (!data?.url && data?.success === false && typeof data?.message === 'string' && data.message.includes('сессии')) {
      console.log(`[rezka] Session expired for ${contentId}, refreshing…`);
      await refreshSessionCookies(contentId);
      // Always warm up on retry — the content page may have initialized a different season
      await warmUpSeason(contentId, translatorId, season);
      const fresh = sessionStore.get(contentId);
      const retryParams = new URLSearchParams({
        id: contentId,
        translator_id: translatorId,
        season: String(season),
        episode: String(episode),
        favs: fresh?.favs || '',
        action: 'get_stream',
      });
      ({ data } = await axios.post(
        `${BASE}/ajax/get_cdn_series/?t=${Date.now()}`,
        retryParams.toString(),
        { headers: buildAjaxHeaders(contentId), timeout: 10_000 }
      ));
    }

    if (!data?.url) {
      console.warn(`[rezka] No URL in AJAX response:`, JSON.stringify(data));
      return null;
    }

    console.log(`[rezka] Raw URL (first 500): ${data.url.slice(0, 500)}`);
    const qualities = parseStreamQualities(data.url);
    console.log(`[rezka] Parsed qualities:`, Object.keys(qualities));

    if (Object.keys(qualities).length === 0) return null;

    cache.set(cacheKey, qualities, 900);
    return qualities;
  } catch (err) {
    console.warn(`[rezka] Series stream failed (id=${contentId} tr=${translatorId} s${season}e${episode}): ${err.message} | code: ${err.code || 'N/A'} | status: ${err.response?.status || 'N/A'}`);
    return null;
  }
}

/**
 * Fetch stream URLs for a movie.
 */
async function getMovieStreams(contentId, translatorId) {
  const cacheKey = `streams:movie:${contentId}:${translatorId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const session = sessionStore.get(contentId);
    const params = new URLSearchParams({
      id: contentId,
      translator_id: translatorId,
      favs: session?.favs || '',
      action: 'get_movie',
    });

    let { data } = await axios.post(
      `${BASE}/ajax/get_cdn_series/?t=${Date.now()}`,
      params.toString(),
      { headers: buildAjaxHeaders(contentId), timeout: 10_000 }
    );

    // Log non-success AJAX responses for diagnostics
    if (data?.success === false) {
      console.warn(`[rezka] AJAX error (movie id=${contentId} tr=${translatorId}): success=false, message="${data.message || 'N/A'}"`);
    }

    // Session expired — refresh cookies + favs token and retry once
    if (!data?.url && data?.success === false && typeof data?.message === 'string' && data.message.includes('сессии')) {
      console.log(`[rezka] Session expired for ${contentId}, refreshing…`);
      await refreshSessionCookies(contentId);
      const fresh = sessionStore.get(contentId);
      const retryParams = new URLSearchParams({
        id: contentId,
        translator_id: translatorId,
        favs: fresh?.favs || '',
        action: 'get_movie',
      });
      ({ data } = await axios.post(
        `${BASE}/ajax/get_cdn_series/?t=${Date.now()}`,
        retryParams.toString(),
        { headers: buildAjaxHeaders(contentId), timeout: 10_000 }
      ));
    }

    if (!data?.url) {
      console.warn(`[rezka] No URL in AJAX response:`, JSON.stringify(data));
      return null;
    }

    console.log(`[rezka] Raw URL (first 500): ${data.url.slice(0, 500)}`);
    const qualities = parseStreamQualities(data.url);
    console.log(`[rezka] Parsed qualities:`, Object.keys(qualities));

    if (Object.keys(qualities).length === 0) return null;

    cache.set(cacheKey, qualities, 900);
    return qualities;
  } catch (err) {
    console.warn(`[rezka] Movie stream failed (id=${contentId} tr=${translatorId}): ${err.message} | code: ${err.code || 'N/A'} | status: ${err.response?.status || 'N/A'}`);
    return null;
  }
}

module.exports = { search, getContentInfo, getSeriesStreams, getMovieStreams, initSession };
