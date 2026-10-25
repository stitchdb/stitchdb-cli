// Copied from the platform (lib/mcp-types.js) by cli/build.sh so local and remote types are identical.
// TypeScript types from a project's schema (tables, views, functions, enums), in the shape stitchdb-js understands:
// Database[schema]['Tables'][table]['Row' | 'Insert' | 'Update' | 'Relationships'].
'use strict';

const NUM = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'oid', 'money']);
const STR = new Set(['text', 'varchar', 'bpchar', 'char', 'name', 'uuid', 'citext', 'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval', 'bytea',
  'inet', 'cidr', 'macaddr', 'macaddr8', 'tsvector', 'tsquery', 'xml', 'bit', 'varbit', 'vector', 'halfvec', 'sparsevec', 'geometry', 'geography', 'ltree', 'regclass', 'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange']);
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
const ind = (n) => '  '.repeat(n);

function tsType(t, enums) {
  // t: { typname, typtype, elem, schema }
  if (t.elem) return `${tsType({ typname: t.elem, typtype: t.elem_typtype, schema: t.elem_schema }, enums)}[]`;
  if (t.typtype === 'e' && enums.has(`${t.schema}.${t.typname}`)) return `Database[${JSON.stringify(t.schema)}]["Enums"][${JSON.stringify(t.typname)}]`;
  if (t.typtype === 'e') return 'string';
  const n = t.typname;
  if (n === 'bool') return 'boolean';
  if (NUM.has(n)) return 'number';
  if (STR.has(n)) return 'string';
  if (n === 'json' || n === 'jsonb') return 'Json';
  if (n === 'void') return 'undefined';
  if (n === 'record') return 'Record<string, unknown>';
  return 'unknown';
}

// The schema as plain rows (columns, enums, foreign keys, functions); shared by the TypeScript emitter below and the
// Dart / Swift / Kotlin emitters in lib/typegen.js.
async function introspect(q, schemas = ['public']) {
  const cols = await q(`select n.nspname as schema, c.relname as rel, c.relkind::text as kind, a.attname as col, a.attnum::int as pos,
      t.typname, t.typtype::text, tn.nspname as type_schema, et.typname as elem, et.typtype::text as elem_typtype, etn.nspname as elem_schema,
      not a.attnotnull as nullable, a.atthasdef as has_default, a.attidentity::text as identity, a.attgenerated::text as generated
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_type t on t.oid = a.atttypid join pg_namespace tn on tn.oid = t.typnamespace
    left join pg_type et on et.oid = t.typelem and t.typcategory = 'A' left join pg_namespace etn on etn.oid = et.typnamespace
    where n.nspname = any($1) and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
    order by 1, 2, a.attnum`, [schemas]);
  const enums = await q(`select n.nspname as schema, t.typname as name, array_agg(e.enumlabel order by e.enumsortorder)::text[] as labels
    from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid where n.nspname = any($1) group by 1, 2 order by 1, 2`, [schemas]);
  const rels = await q(`select n.nspname as schema, c.relname as rel, k.conname as name,
      array(select a.attname::text from unnest(k.conkey) with ordinality x(n, o) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n order by x.o) as cols,
      fn.nspname as ref_schema, fc.relname as ref_rel,
      array(select a.attname::text from unnest(k.confkey) with ordinality x(n, o) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.n order by x.o) as ref_cols,
      exists(select 1 from pg_index i where i.indrelid = k.conrelid and i.indisunique and (i.indkey::int2[])::int2[] @> k.conkey and array_length(k.conkey, 1) = i.indnatts) as one_to_one
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_class fc on fc.oid = k.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
    where k.contype = 'f' and n.nspname = any($1) order by 1, 2, 3`, [schemas]);
  const fns = await q(`select n.nspname as schema, p.proname as name, p.proretset as setof, rt.typname as ret, rt.typtype::text as ret_typtype, rtn.nspname as ret_schema,
      ret.typname as ret_elem, p.pronargs::int as nargs, p.pronargdefaults::int as ndefaults, p.prokind::text as kind,
      coalesce((select json_agg(json_build_object('name', coalesce(p.proargnames[x.i], ''), 'typname', ty.typname, 'typtype', ty.typtype::text, 'schema', tyn.nspname,
          'elem', ety.typname, 'mode', coalesce(p.proargmodes[x.i], 'i')) order by x.i)
        from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality x(t, i) join pg_type ty on ty.oid = x.t join pg_namespace tyn on tyn.oid = ty.typnamespace
        left join pg_type ety on ety.oid = ty.typelem and ty.typcategory = 'A'), '[]') as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type rt on rt.oid = p.prorettype join pg_namespace rtn on rtn.oid = rt.typnamespace
    left join pg_type ret on ret.oid = rt.typelem and rt.typcategory = 'A'
    where n.nspname = any($1) and p.prokind = 'f' and rt.typname not in ('trigger', 'event_trigger')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by 1, 2`, [schemas]);

  return { cols, enums, rels, fns };
}
async function generate(q, schemas = ['public']) { return emitTs(await introspect(q, schemas), schemas); }
function emitTs({ cols, enums, rels, fns }, schemas) {
  const enumSet = new Set(enums.map((e) => `${e.schema}.${e.name}`));
  const colType = (c) => tsType({ typname: c.typname, typtype: c.typtype, schema: c.type_schema, elem: c.elem, elem_typtype: c.elem_typtype, elem_schema: c.elem_schema }, enumSet);
  const out = ['export type Json =', '  | string', '  | number', '  | boolean', '  | null', '  | { [key: string]: Json | undefined }', '  | Json[]', '', 'export type Database = {'];
  for (const s of schemas) {
    const mine = cols.filter((c) => c.schema === s);
    const byRel = new Map();
    for (const c of mine) { if (!byRel.has(c.rel)) byRel.set(c.rel, { kind: c.kind, cols: [] }); byRel.get(c.rel).cols.push(c); }
    const relLines = (name) => {
      const r = rels.filter((x) => x.schema === s && x.rel === name);
      if (!r.length) return [`${ind(4)}Relationships: []`];
      return [`${ind(4)}Relationships: [`, ...r.flatMap((x) => [`${ind(5)}{`, `${ind(6)}foreignKeyName: ${JSON.stringify(x.name)}`, `${ind(6)}columns: ${JSON.stringify(x.cols)}`,
        `${ind(6)}isOneToOne: ${x.one_to_one}`, `${ind(6)}referencedRelation: ${JSON.stringify(x.ref_rel)}`, `${ind(6)}referencedColumns: ${JSON.stringify(x.ref_cols)}`, `${ind(5)}},`]), `${ind(4)}]`];
    };
    out.push(`${ind(1)}${key(s)}: {`, `${ind(2)}Tables: {`);
    let any = false;
    for (const [name, r] of byRel) {
      if (!['r', 'p', 'f'].includes(r.kind)) continue;
      any = true;
      const row = r.cols.map((c) => `${ind(5)}${key(c.col)}: ${colType(c)}${c.nullable ? ' | null' : ''}`);
      const ins = r.cols.map((c) => {
        if (c.identity === 'a' || c.generated === 's') return `${ind(5)}${key(c.col)}?: never`;
        const opt = c.nullable || c.has_default || c.identity === 'd';
        return `${ind(5)}${key(c.col)}${opt ? '?' : ''}: ${colType(c)}${c.nullable ? ' | null' : ''}`;
      });
      const upd = r.cols.map((c) => (c.identity === 'a' || c.generated === 's' ? `${ind(5)}${key(c.col)}?: never` : `${ind(5)}${key(c.col)}?: ${colType(c)}${c.nullable ? ' | null' : ''}`));
      out.push(`${ind(3)}${key(name)}: {`, `${ind(4)}Row: {`, ...row, `${ind(4)}}`, `${ind(4)}Insert: {`, ...ins, `${ind(4)}}`, `${ind(4)}Update: {`, ...upd, `${ind(4)}}`, ...relLines(name), `${ind(3)}}`);
    }
    if (!any) out.push(`${ind(3)}[_ in never]: never`);
    out.push(`${ind(2)}}`);
    out.push(`${ind(2)}Views: {`);
    any = false;
    for (const [name, r] of byRel) {
      if (!['v', 'm'].includes(r.kind)) continue;
      any = true;
      out.push(`${ind(3)}${key(name)}: {`, `${ind(4)}Row: {`, ...r.cols.map((c) => `${ind(5)}${key(c.col)}: ${colType(c)} | null`), `${ind(4)}}`, `${ind(4)}Relationships: []`, `${ind(3)}}`);
    }
    if (!any) out.push(`${ind(3)}[_ in never]: never`);
    out.push(`${ind(2)}}`, `${ind(2)}Functions: {`);
    const myFns = fns.filter((f) => f.schema === s);
    for (const f of myFns) {
      const args = (f.args || []).filter((a) => ['i', 'b', 'v'].includes(a.mode));
      const outs = (f.args || []).filter((a) => ['o', 'b', 't'].includes(a.mode));
      const firstDefault = f.nargs - f.ndefaults;
      const t = (a) => tsType({ typname: a.typname, typtype: a.typtype, schema: a.schema, elem: a.elem }, enumSet);
      const argLines = args.map((a, i) => `${ind(5)}${key(a.name || `arg${i + 1}`)}${i >= firstDefault ? '?' : ''}: ${t(a)}`);
      let ret = outs.length ? `{\n${outs.map((a, i) => `${ind(6)}${key(a.name || `column${i + 1}`)}: ${t(a)}`).join('\n')}\n${ind(5)}}${f.setof ? '[]' : ''}`
        : `${tsType({ typname: f.ret, typtype: f.ret_typtype, schema: f.ret_schema, elem: f.ret_elem }, enumSet)}${f.setof ? '[]' : ''}`;
      if (!outs.length && f.ret_typtype === 'c') ret = `Record<string, unknown>${f.setof ? '[]' : ''}`;
      out.push(`${ind(3)}${key(f.name)}: {`, args.length ? `${ind(4)}Args: {\n${argLines.join('\n')}\n${ind(4)}}` : `${ind(4)}Args: Record<PropertyKey, never>`, `${ind(4)}Returns: ${ret}`, `${ind(3)}}`);
    }
    if (!myFns.length) out.push(`${ind(3)}[_ in never]: never`);
    out.push(`${ind(2)}}`, `${ind(2)}Enums: {`);
    const myEnums = enums.filter((e) => e.schema === s);
    for (const e of myEnums) out.push(`${ind(3)}${key(e.name)}: ${e.labels.map((l) => JSON.stringify(l)).join(' | ')}`);
    if (!myEnums.length) out.push(`${ind(3)}[_ in never]: never`);
    out.push(`${ind(2)}}`, `${ind(2)}CompositeTypes: {`, `${ind(3)}[_ in never]: never`, `${ind(2)}}`, `${ind(1)}}`);
  }
  out.push('}', '',
    `type PublicSchema = Database[${JSON.stringify(schemas.includes('public') ? 'public' : schemas[0])}]`, '',
    'export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"]',
    'export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"]',
    'export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"]',
    'export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T]', '');
  return out.join('\n');
}

module.exports = { generate, introspect, emitTs, tsType };
