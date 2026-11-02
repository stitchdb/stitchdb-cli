// Every command, keyed by its full name ("db push"). Keys starting with "_" are helpers for tests.
'use strict';
const all = Object.assign({},
  require('./account'), require('./local'), require('./db'), require('./functions'), require('./branches'), require('./import'), require('./sourcemaps'),
  require('./projects'), require('./settings'), require('./integrations'), require('./orgs'), require('./observe'), require('./agents'), require('./apps'));
module.exports = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('_')));
