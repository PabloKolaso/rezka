const { version } = require('../package.json');

const manifest = {
  id: 'community.rezka.stremio',
  version,
  name: 'HDRezka',
  description: 'Movies and series streams from HDRezka (rezka.ag). Provides multiple translation options per title.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    adult: false,
    p2p: false,
  },
};

module.exports = manifest;
