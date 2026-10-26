// Every command, keyed by its full name ("db push"). Keys starting with "_" are helpers for tests.
'use strict';
const all = Object.assign({},
  require('./account'), require('./local'), require('./db'), require('./functions'), require('./branches'), require('./import'));
module.exports = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('_')));
