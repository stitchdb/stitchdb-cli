// Minimal argv parser: positionals, --flag, --flag=value, --flag value, -x value, --no-flag, repeated flags -> arrays.
'use strict';

// spec: { name: { type: 'string'|'boolean'|'array', alias?: 'x' } }
function parse(argv, spec = {}) {
  const alias = {};
  for (const [k, v] of Object.entries(spec)) if (v.alias) alias[v.alias] = k;
  const flags = {}, pos = [];
  const set = (k, v) => {
    const t = spec[k]?.type || (v === true ? 'boolean' : 'string');
    if (t === 'array') (flags[k] ||= []).push(...String(v).split(',').map((s) => s.trim()).filter(Boolean));
    else flags[k] = t === 'boolean' ? v !== false && v !== 'false' : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s, 2);
      k = k.replace(/-([a-z])/g, (_, x) => x.toUpperCase());
      if (k.startsWith('no') && /^no[A-Z]/.test(k) && v === undefined && spec[k[2].toLowerCase() + k.slice(3)]?.type === 'boolean') { set(k[2].toLowerCase() + k.slice(3), false); continue; }
      const type = spec[k]?.type;
      if (v === undefined) v = type === 'boolean' || type === undefined && (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) ? true : argv[++i];
      set(k, v);
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const k = alias[a.slice(1)] || a.slice(1);
      const type = spec[k]?.type;
      set(k, type === 'boolean' ? true : argv[++i]);
    } else pos.push(a);
  }
  return { flags, pos };
}

module.exports = { parse };
