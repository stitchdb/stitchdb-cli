// Copied from the platform (lib/typegen-emit.js) by cli/build.sh so local and remote types are identical.
// Dart, Swift and Kotlin model types from a project's schema (ROADMAP P39). Input is lib/mcp-types.js introspect():
// per table / view a Row type (every column) and, for tables, an Insert type (columns with a default, identity or null
// optional; generated columns left out); per enum a native enum. Pure functions, unit-tested (tests/typegen.test.js).
//   Dart:   plain classes with fromJson / toJson, no packages needed.
//   Swift:  Codable + Hashable + Sendable structs in `enum Database { }`, with a small JSON type for json / jsonb.
//   Kotlin: kotlinx.serialization @Serializable data classes, json / jsonb as JsonElement.
// Timestamps, dates, uuids and other text-like types are strings (exactly what the API returns).
'use strict';

const INT = new Set(['int2', 'int4', 'oid']);
const BIG = new Set(['int8']);
const DBL = new Set(['float4', 'float8', 'numeric', 'money']);
const { tsType } = require('./types');

const DART_KW = new Set(('abstract as assert async await base break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync this throw true try type typedef var void when while with yield'
  + ' hashCode runtimeType toString toJson fromJson noSuchMethod tableName values index name').split(' '));
const SWIFT_KW = new Set('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil super self Self throw throws true try Type Protocol'.split(' '));
const SWIFT_RESERVED_FIELD = new Set(['tableName', 'CodingKeys', 'hashValue']);
const KT_KW = new Set('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'.split(' '));
const KT_RESERVED_FIELD = new Set(['TABLE', 'Companion']);

const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
function pascal(s) {
  const r = words(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('') || 'X';
  return /^\d/.test(r) ? `T${r}` : r;
}
function camel(s) { const p = pascal(s); return p[0].toLowerCase() + p.slice(1); }
const upperSnake = (s) => { const r = words(s).map((w) => w.toUpperCase()).join('_') || 'X'; return /^\d/.test(r) ? `V_${r}` : r; };
// Hand out unique names: the second "user_id" / "userId" becomes userId2.
function namer(taken = []) {
  const used = new Set(taken);
  return (n) => { let v = n, i = 2; while (used.has(v)) v = `${n}${i++}`; used.add(v); return v; };
}
const str = (s) => JSON.stringify(String(s)); // a valid string literal in Dart, Swift and Kotlin for plain names
const dartStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;
const ktStr = (s) => JSON.stringify(String(s)).replace(/\$/g, '\\$');

// One neutral model for every language: schemas → enums, tables, views with typed columns.
function shape({ cols, enums }, schemas) {
  const relName = namer(['Database', 'JSON', 'Json']);
  const enumMap = new Map();
  const out = { enums: [], tables: [], views: [] };
  const qual = (schema, name) => (schema === 'public' || schemas.length === 1 ? pascal(name) : pascal(schema) + pascal(name));
  for (const e of enums) {
    const name = relName(qual(e.schema, e.name));
    enumMap.set(`${e.schema}.${e.name}`, name);
    out.enums.push({ schema: e.schema, pg: e.name, name, labels: e.labels });
  }
  const t = (typname, typtype, schema, elem, elemTyptype, elemSchema) => {
    if (elem) return { list: t(elem, elemTyptype, elemSchema) };
    if (typtype === 'e') return enumMap.has(`${schema}.${typname}`) ? { enum: enumMap.get(`${schema}.${typname}`) } : { base: 'string' };
    if (typname === 'bool') return { base: 'bool' };
    if (INT.has(typname)) return { base: 'int' };
    if (BIG.has(typname)) return { base: 'bigint' };
    if (DBL.has(typname)) return { base: 'double' };
    const ts = tsType({ typname, typtype, schema }, new Set());
    if (ts === 'string') return { base: 'string' };
    return { base: 'json' };
  };
  const byRel = new Map();
  for (const c of cols) {
    const k = `${c.schema}.${c.rel}`;
    if (!byRel.has(k)) byRel.set(k, { schema: c.schema, pg: c.rel, kind: c.kind, cols: [] });
    byRel.get(k).cols.push({ pg: c.col, type: t(c.typname, c.typtype, c.type_schema, c.elem, c.elem_typtype, c.elem_schema),
      nullable: ['v', 'm'].includes(c.kind) ? true : !!c.nullable, optional: !!(c.nullable || c.has_default || c.identity === 'd'),
      readonly: c.identity === 'a' || c.generated === 's' });
  }
  for (const r of byRel.values()) {
    const rel = { schema: r.schema, pg: r.pg, path: r.schema === 'public' ? r.pg : `${r.schema}.${r.pg}`, name: relName(qual(r.schema, r.pg)), cols: r.cols };
    (['r', 'p', 'f'].includes(r.kind) ? out.tables : out.views).push(rel);
  }
  for (const r of out.tables) r.insertName = relName(`${r.name}Insert`);
  return out;
}

const header = (c, ref, version) => [`${c} Generated by StitchDB from the database schema${ref ? ` of project ${ref}` : ''}${version ? ` (version ${version})` : ''}.`,
  `${c} Do not edit: it is rewritten when the schema changes. https://stitchdb.com/docs/database/typed-clients`];

// ---------- Dart ----------
function dart(model, schemas, { ref, version } = {}) {
  const m = shape(model, schemas);
  const L = [...header('//', ref, version), '// ignore_for_file: type=lint, unused_element', ''];
  const ty = (t) => (t.list ? `List<${ty(t.list)}>` : t.enum ? t.enum : { bool: 'bool', int: 'int', bigint: 'int', double: 'double', string: 'String', json: 'Object' }[t.base]);
  const decode = (t, v, nullable) => {
    const q = nullable ? '?' : '';
    if (t.base === 'json') return nullable ? v : `${v} as Object`;
    const n = nullable ? `${v} == null ? null : ` : '';
    if (t.list) return `${n}(${v} as List).map((e) => ${decode(t.list, 'e', false)}).toList()`;
    if (t.enum) return `${n}${t.enum}.fromJson(${v} as String)`;
    if (t.base === 'int' || t.base === 'bigint') return `(${v} as num${q})${q}.toInt()`;
    if (t.base === 'double') return `(${v} as num${q})${q}.toDouble()`;
    return `${v} as ${ty(t)}${q}`;
  };
  const encode = (t, v, nullable) => {
    const q = nullable ? '?' : '';
    if (t.enum) return `${v}${q}.toJson()`;
    if (t.list && (t.list.enum || t.list.list)) return `${v}${q}.map((e) => ${encode(t.list, 'e', false)}).toList()`;
    return v;
  };
  const field = (pg, taken) => { let n = camel(pg); if (DART_KW.has(n)) n += '_'; return taken(n); };
  for (const e of m.enums) {
    const nm = namer(['values', 'index', 'name', 'value']);
    const vals = e.labels.map((l, i) => { let n = camel(l); if (!/^[a-z_]/i.test(n)) n = `v${i}`; if (DART_KW.has(n)) n += '_'; return [nm(n), l]; });
    L.push(`enum ${e.name} {`, ...vals.map(([n, l], i) => `  ${n}(${dartStr(l)})${i === vals.length - 1 ? ';' : ','}`),
      '', `  const ${e.name}(this.value);`, '  final String value;',
      `  static ${e.name} fromJson(String v) => values.firstWhere((e) => e.value == v, orElse: () => throw ArgumentError.value(v, '${e.name}'));`,
      '  String toJson() => value;', '}', '');
  }
  const cls = (name, rel, cols, insert) => {
    const taken = namer();
    const fs = cols.map((c) => ({ ...c, n: field(c.pg, taken), nullable: c.type.base === 'json' ? false : insert ? c.optional || c.nullable : c.nullable }));
    const t = (c) => `${ty(c.type)}${c.nullable || c.type.base === 'json' ? '?' : ''}`;
    L.push(`class ${name} {`, `  static const tableName = ${dartStr(rel.path)};`, '');
    for (const c of fs) L.push(`  final ${t(c)} ${c.n};`);
    L.push('', fs.length ? `  const ${name}({${fs.map((c) => (insert ? c.optional : c.nullable || c.type.base === 'json') ? `this.${c.n}` : `required this.${c.n}`).join(', ')}});` : `  const ${name}();`, '');
    L.push(`  factory ${name}.fromJson(Map<String, dynamic> json) => ${name}(`, ...fs.map((c) => `        ${c.n}: ${decode(c.type, `json[${dartStr(c.pg)}]`, c.nullable || c.type.base === 'json')},`), '      );', '');
    if (insert) {
      // Optional values left null are not sent, so the column default applies.
      L.push('  Map<String, dynamic> toJson() => {', ...fs.map((c) => `        ${c.optional ? `if (${c.n} != null) ` : ''}${dartStr(c.pg)}: ${encode(c.type, c.n, c.optional || c.nullable)},`), '      };');
    } else {
      L.push('  Map<String, dynamic> toJson() => {', ...fs.map((c) => `        ${dartStr(c.pg)}: ${encode(c.type, c.n, c.nullable)},`), '      };');
    }
    L.push('}', '');
  };
  for (const r of m.tables) { cls(r.name, r, r.cols, false); cls(r.insertName, r, r.cols.filter((c) => !c.readonly), true); }
  for (const r of m.views) cls(r.name, r, r.cols, false);
  return L.join('\n');
}

// ---------- Swift ----------
function swift(model, schemas, { ref, version } = {}) {
  const m = shape(model, schemas);
  const ty = (t) => (t.list ? `[${ty(t.list)}]` : t.enum ? t.enum : { bool: 'Bool', int: 'Int', bigint: 'Int64', double: 'Double', string: 'String', json: 'JSON' }[t.base]);
  const id = (n) => (SWIFT_KW.has(n) ? `\`${n}\`` : n);
  const L = [...header('//', ref, version), 'import Foundation', '', 'public enum Database {',
    '  /// Any JSON value (json / jsonb columns).',
    '  public enum JSON: Codable, Hashable, Sendable {',
    '    case string(String), number(Double), bool(Bool), object([String: JSON]), array([JSON]), null',
    '    public init(from decoder: Decoder) throws {',
    '      let c = try decoder.singleValueContainer()',
    '      if c.decodeNil() { self = .null } else if let v = try? c.decode(Bool.self) { self = .bool(v) } else if let v = try? c.decode(Double.self) { self = .number(v) }',
    '      else if let v = try? c.decode(String.self) { self = .string(v) } else if let v = try? c.decode([JSON].self) { self = .array(v) } else { self = .object(try c.decode([String: JSON].self)) }',
    '    }',
    '    public func encode(to encoder: Encoder) throws {',
    '      var c = encoder.singleValueContainer()',
    '      switch self { case .string(let v): try c.encode(v); case .number(let v): try c.encode(v); case .bool(let v): try c.encode(v)',
    '      case .object(let v): try c.encode(v); case .array(let v): try c.encode(v); case .null: try c.encodeNil() }',
    '    }', '  }', ''];
  for (const e of m.enums) {
    const nm = namer();
    L.push(`  public enum ${e.name}: String, Codable, Hashable, Sendable, CaseIterable {`,
      ...e.labels.map((l, i) => { let n = camel(l); if (!/^[a-z_]/i.test(n)) n = `v${i}`; return `    case ${id(nm(n))} = ${str(l)}`; }), '  }', '');
  }
  const st = (name, rel, cols, insert) => {
    const taken = namer([...SWIFT_RESERVED_FIELD]);
    const fs = cols.map((c) => ({ ...c, n: taken(camel(c.pg)), opt: insert ? c.optional || c.nullable : c.nullable }));
    const t = (c) => `${ty(c.type)}${c.opt ? '?' : ''}`;
    L.push(`  public struct ${name}: Codable, Hashable, Sendable {`, `    public static let tableName = ${str(rel.path)}`);
    for (const c of fs) L.push(`    public var ${id(c.n)}: ${t(c)}`);
    L.push(`    public init(${fs.map((c) => `${id(c.n)}: ${t(c)}${c.opt ? ' = nil' : ''}`).join(', ')}) {`, ...fs.map((c) => `      self.${id(c.n)} = ${id(c.n)}`), '    }');
    if (fs.length) L.push(`    enum CodingKeys: String, CodingKey { ${fs.map((c) => `case ${id(c.n)} = ${str(c.pg)}`).join('; ')} }`);
    L.push('  }', '');
  };
  for (const r of m.tables) { st(r.name, r, r.cols, false); st(r.insertName, r, r.cols.filter((c) => !c.readonly), true); }
  for (const r of m.views) st(r.name, r, r.cols, false);
  L.push('}', '');
  return L.join('\n');
}

// ---------- Kotlin ----------
function kotlin(model, schemas, { ref, version, pkg = 'database' } = {}) {
  const m = shape(model, schemas);
  const ty = (t) => (t.list ? `List<${ty(t.list)}>` : t.enum ? t.enum : { bool: 'Boolean', int: 'Int', bigint: 'Long', double: 'Double', string: 'String', json: 'JsonElement' }[t.base]);
  const id = (n) => (KT_KW.has(n) ? `\`${n}\`` : n);
  const L = [...header('//', ref, version), '@file:Suppress("unused", "PropertyName")', '', `package ${pkg}`, '',
    'import kotlinx.serialization.SerialName', 'import kotlinx.serialization.Serializable', 'import kotlinx.serialization.json.JsonElement', ''];
  for (const e of m.enums) {
    const nm = namer(['Companion']);
    L.push('@Serializable', `enum class ${e.name}(val value: String) {`,
      ...e.labels.map((l, i) => `    @SerialName(${ktStr(l)}) ${nm(/^[A-Za-z_]/.test(upperSnake(l)) ? upperSnake(l) : `V${i}`)}(${ktStr(l)}),`), '}', '');
  }
  const dc = (name, rel, cols, insert) => {
    const taken = namer([...KT_RESERVED_FIELD]);
    const fs = cols.map((c) => ({ ...c, n: taken(camel(c.pg)), opt: insert ? c.optional || c.nullable : c.nullable }));
    L.push('@Serializable');
    if (!fs.length) L.push(`class ${name} {`); else {
      L.push(`data class ${name}(`, ...fs.map((c) => `    @SerialName(${ktStr(c.pg)}) val ${id(c.n)}: ${ty(c.type)}${c.opt ? '? = null' : ''},`), ') {');
    }
    L.push(`    companion object { const val TABLE = ${ktStr(rel.path)} }`, '}', '');
  };
  for (const r of m.tables) { dc(r.name, r, r.cols, false); dc(r.insertName, r, r.cols.filter((c) => !c.readonly), true); }
  for (const r of m.views) dc(r.name, r, r.cols, false);
  return L.join('\n');
}

module.exports = { dart, swift, kotlin, shape, pascal, camel, upperSnake };
