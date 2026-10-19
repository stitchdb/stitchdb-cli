// Small TOML reader for stitchdb/config.toml: [tables], [nested.tables], key = "string" | 'string' | number | bool | [arrays].
'use strict';

function parseValue(raw, where) {
  const v = raw.trim();
  if (/^"/.test(v)) return JSON.parse(v.replace(/\\'/g, "'"));
  if (/^'/.test(v)) return v.slice(1, v.lastIndexOf("'"));
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(v)) return Number(v.replace(/_/g, ''));
  if (v.startsWith('[')) {
    const inner = v.slice(1, v.lastIndexOf(']')).trim();
    if (!inner) return [];
    const items = []; let cur = '', q = null;
    for (const ch of inner) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === ',') { if (cur.trim()) items.push(parseValue(cur, where)); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) items.push(parseValue(cur, where));
    return items;
  }
  throw new Error(`config.toml ${where}: cannot read value ${v}`);
}
const stripComment = (line) => {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q && line[i - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'") q = ch; else if (ch === '#') return line.slice(0, i);
  }
  return line;
};

function parse(text) {
  const root = {};
  let cur = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (!line) continue;
    // Multi-line arrays.
    if (/=\s*\[[^\]]*$/.test(line)) { while (i + 1 < lines.length && !line.includes(']')) line += ' ' + stripComment(lines[++i]).trim(); }
    const t = /^\[([A-Za-z0-9_.\-"]+)\]$/.exec(line);
    if (t) {
      cur = root;
      for (const part of t[1].split('.').map((s) => s.replace(/"/g, ''))) cur = (cur[part] ||= {});
      continue;
    }
    const kv = /^([A-Za-z0-9_\-"]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`config.toml line ${i + 1}: cannot parse "${line}"`);
    cur[kv[1].replace(/"/g, '')] = parseValue(kv[2], `line ${i + 1}`);
  }
  return root;
}

module.exports = { parse };
