/**
 * Stream Handler
 *
 * Called by Stremio when a user selects a movie or episode.
 * Returns stream objects for all available translators and qualities.
 */

const resolver = require('../bridge/resolver');
const rezka    = require('../api/rezka');

const IMDB_RE = /^tt\d{7,10}$/;

const ADDON_HOST = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 7000}`;

// Quality preference order (best first) — 360p/480p excluded intentionally
const QUALITY_ORDER = ['1080p Ultra', '1080p', '720p'];
const SKIP_QUALITIES = new Set(['360p', '360p MP4', '480p', '480p MP4']);

function proxyUrl(url) {
  return `${ADDON_HOST}/proxy/stream?url=${encodeURIComponent(url)}`;
}

/**
 * Parse a Stremio ID into components.
 * "tt0944947:1:1" → { imdbId: "tt0944947", season: 1, episode: 1 }
 * "tt0068646"     → { imdbId: "tt0068646", season: null, episode: null }
 */
function parseId(id) {
  const parts = id.split(':');
  return {
    imdbId:  parts[0],
    season:  parts[1] ? parseInt(parts[1], 10) : null,
    episode: parts[2] ? parseInt(parts[2], 10) : null,
  };
}

/**
 * Build Stremio stream objects from a quality map.
 * @param {{ [quality: string]: string }} qualities
 * @param {string} translatorName
 * @param {string} contentTitle
 * @param {string} imdbId
 * @returns {Array}
 */
function buildStreams(qualities, translatorName, contentTitle, imdbId) {
  const streams = [];

  for (const quality of QUALITY_ORDER) {
    const url = qualities[quality];
    if (!url) continue;

    streams.push({
      url: proxyUrl(url),
      name: `HDRezka\n${quality}`,
      description: `${contentTitle}\n${translatorName}`,
      behaviorHints: {
        bingeGroup: `rezka-${imdbId}`,
      },
    });
  }

  // Include any extra qualities not in our preferred list (e.g. MP4 fallbacks)
  for (const [quality, url] of Object.entries(qualities)) {
    if (!QUALITY_ORDER.includes(quality) && !SKIP_QUALITIES.has(quality) && url) {
      streams.push({
        url: proxyUrl(url),
        name: `HDRezka\n${quality}`,
        description: `${contentTitle}\n${translatorName}`,
        behaviorHints: {
          bingeGroup: `rezka-${imdbId}`,
        },
      });
    }
  }

  return streams;
}

/**
 * Main stream handler.
 * @param {{ type: string, id: string }} args
 * @returns {{ streams: object[] }}
 */
async function streamHandler({ type, id }) {
  const { imdbId, season, episode } = parseId(id);

  if (!IMDB_RE.test(imdbId)) return { streams: [] };

  console.log(`[streams] Request: type=${type} imdb=${imdbId} s=${season} e=${episode}`);

  // Step 1: resolve IMDB → Rezka content ID + translators
  let resolution;
  try {
    resolution = await resolver.resolveImdbDetailed(imdbId, type, season);
  } catch (err) {
    console.error(`[streams] Resolution error for ${imdbId}:`, err.message);
    return { streams: [] };
  }

  if (!resolution.id) {
    console.log(`[streams] No Rezka match for ${imdbId}`);
    return { streams: [], cacheMaxAge: 3600 };
  }

  const { id: contentId, translators, title: contentTitle, url: contentUrl } = resolution;
  // Ensure sessionStore knows the page URL even when resolution came from disk cache
  // (in that case getContentInfo is skipped, leaving sessionStore empty)
  if (contentUrl) rezka.initSession(contentId, contentUrl);

  const isSeries = type === 'series' && season !== null && episode !== null;

  // Step 2: fetch streams for each free translator sequentially
  // Sequential to avoid triggering Rezka's rate limiting / session validation
  const freeTranslators = translators.filter(t => !t.isPremium).slice(0, 5);
  const activeTranslators = freeTranslators.length > 0 ? freeTranslators : translators.slice(0, 3);

  if (activeTranslators.length === 0) {
    console.log(`[streams] No translators found for ${contentId}`);
    return { streams: [] };
  }

  const streams = [];
  for (const translator of activeTranslators) {
    try {
      let qualities;
      if (isSeries) {
        qualities = await rezka.getSeriesStreams(contentId, translator.id, season, episode);
      } else {
        qualities = await rezka.getMovieStreams(contentId, translator.id);
      }
      if (!qualities || Object.keys(qualities).length === 0) {
        console.warn(`[streams] Translator ${translator.id} (${translator.name}) returned no streams`);
        continue;
      }
      streams.push(...buildStreams(qualities, translator.name, contentTitle || 'HDRezka', imdbId));
    } catch (err) {
      console.warn(`[streams] Translator ${translator.id} (${translator.name}) failed:`, err.message);
    }
  }

  console.log(`[streams] Returning ${streams.length} stream(s) for ${imdbId}`);
  return { streams };
}

module.exports = { streamHandler };
