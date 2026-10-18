// A small in-memory stand-in for Prisma tables, so a whole flow can run in a unit test.
export type Row = Record<string, any>;
let n = 0;
export const oid = () => (++n).toString(16).padStart(24, '0');

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (k === 'AND') return (v as Row[]).every((w) => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ('gte' in v) return row[k] >= v.gte;
      if ('lt' in v) return row[k] < v.lt;
      if ('lte' in v) return row[k] <= v.lte;
      if ('contains' in v) return String(row[k] ?? '').toLowerCase().includes(String(v.contains).toLowerCase());
      if ('isSet' in v) return v.isSet ? row[k] !== undefined : row[k] === undefined;
      if ('has' in v) return (row[k] ?? []).includes(v.has);
      return true;
    }
    return (row[k] ?? null) === (v ?? null);
  });
}

export function table(defaults: Row = {}) {
  const rows: Row[] = [];
  const apply = (r: Row, data: Row) => { for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && 'increment' in v ? (r[k] ?? 0) + v.increment : v; };
  const t = {
    rows,
    create: jest.fn(async ({ data }: Row) => { const r = { id: oid(), createdAt: new Date(), ...defaults, ...data }; rows.push(r); return { ...r }; }),
    findUnique: jest.fn(async ({ where }: Row) => { const flat = Object.fromEntries(Object.entries(where).flatMap(([k, v]) => (v && typeof v === 'object' && !(v instanceof Date) ? Object.entries(v as Row) : [[k, v]]))); const r = rows.find((x) => matches(x, flat)); return r ? { ...r } : null; }),
    findUniqueOrThrow: jest.fn(async ({ where }: Row) => { const r = rows.find((x) => matches(x, where)); if (!r) throw new Error('not found'); return { ...r }; }),
    findFirst: jest.fn(async ({ where, orderBy }: Row = {}) => { let hit = rows.filter((x) => matches(x, where)); if (orderBy) { const [k, d] = Object.entries(orderBy as Row)[0] as [string, string]; hit = [...hit].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (d === 'desc' ? -1 : 1)); } return hit[0] ? { ...hit[0] } : null; }),
    findMany: jest.fn(async ({ where, orderBy, take }: Row = {}) => { let out = rows.filter((x) => matches(x, where)).map((x) => ({ ...x })); if (orderBy) { const [k, d] = Object.entries(orderBy as Row)[0] as [string, string]; out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (d === 'desc' ? -1 : 1)); } return take ? out.slice(0, take) : out; }),
    update: jest.fn(async ({ where, data }: Row) => { const r = rows.find((x) => x.id === where.id); if (!r) throw new Error('not found'); apply(r, data); return { ...r }; }),
    updateMany: jest.fn(async ({ where, data }: Row) => { const hit = rows.filter((x) => matches(x, where)); hit.forEach((r) => apply(r, data)); return { count: hit.length }; }),
    upsert: jest.fn(async ({ where, create, update }: Row) => { const flat = Object.fromEntries(Object.entries(where).flatMap(([k, v]) => (v && typeof v === 'object' && !(v instanceof Date) ? Object.entries(v as Row) : [[k, v]]))); const r = rows.find((x) => matches(x, flat)); if (r) { apply(r, update); return { ...r }; } const nr = { id: oid(), createdAt: new Date(), ...defaults, ...create }; rows.push(nr); return { ...nr }; }),
    deleteMany: jest.fn(async ({ where }: Row = {}) => { const keep = rows.filter((x) => !matches(x, where)); const c = rows.length - keep.length; rows.length = 0; rows.push(...keep); return { count: c }; }),
    count: jest.fn(async ({ where }: Row = {}) => rows.filter((x) => matches(x, where)).length),
    aggregate: jest.fn(async ({ where, _sum }: Row = {}) => { const k = Object.keys(_sum ?? {})[0]; const hit = rows.filter((x) => matches(x, where)); return { _sum: k ? { [k]: hit.reduce((t, r) => t + (r[k] ?? 0n), 0n) } : {} }; }),
    groupBy: jest.fn(async ({ by, where, _sum }: Row) => { const k = Object.keys(_sum ?? {})[0]; const groups = new Map<string, Row>(); for (const r of rows.filter((x) => matches(x, where))) { const key = (by as string[]).map((f) => r[f]).join('|'); const g = groups.get(key) ?? { ...Object.fromEntries((by as string[]).map((f) => [f, r[f]])), _sum: { [k]: 0n } }; g._sum[k] += r[k] ?? 0n; groups.set(key, g); } return [...groups.values()]; }),
  };
  return t;
}
export const clearTables = (db: Record<string, any>) => { for (const t of Object.values(db)) if (t && typeof t === 'object' && Array.isArray(t.rows)) t.rows.length = 0; };
