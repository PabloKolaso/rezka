/**
 * Cinemeta Title Info Fetcher
 *
 * Fetches title metadata from Stremio's Cinemeta catalog.
 * Used to get a human-readable title for IMDB ID → Rezka resolution.
 */

const axios = require('axios');

const BASE = 'https://v3-cinemeta.strem.io/meta';
const TIMEOUT_MS = 5_000;

/**
 * Fetch title info from Cinemeta for a given IMDB ID.
 *
 * @param {string} imdbId - e.g. "tt2741602"
 * @param {string} [typeHint] - "series" or "movie" (tried first)
 * @returns {Promise<{title: string, year: number|null}|null>} null on failure
 */
async function fetchTitleInfo(imdbId, typeHint) {
  const types = typeHint === 'movie' ? ['movie', 'series'] : ['series', 'movie'];

  for (const type of types) {
    try {
      const { data } = await axios.get(`${BASE}/${type}/${imdbId}.json`, {
        timeout: TIMEOUT_MS,
      });
      if (data?.meta?.name) {
        const year = data.meta.year ? parseInt(data.meta.year, 10) : null;
        return { title: data.meta.name, year };
      }
    } catch (err) {
      if (err.response?.status === 404) continue;
      console.warn(
        `[cinemeta] Error fetching ${type} for ${imdbId}:`,
        err.message,
        `| code: ${err.code || 'N/A'}`,
        `| status: ${err.response?.status || 'N/A'}`
      );
      continue;
    }
  }
  return null;
}

module.exports = { fetchTitleInfo };
