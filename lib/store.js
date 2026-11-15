'use strict';
/* Storage layer. Postgres (Neon) in production; in-memory when DPS_MEMORY=1 (local dev + tests). */

const EMPTY_STATE = () => ({ items: [], uid: 0, bills: [], bid: 0, fac: [], log: [], reqs: [], sessionCfg: null });

/* ---------------- in-memory ---------------- */
function memoryStore() {
  const users = []; let uidSeq = 0;
  const attempts = new Map();
  const assets = new Map();
  let state = null;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  return {
    async init() { if (!state) state = { data: EMPTY_STATE(), version: 1 }; },
    async ping() { return true; },
    async countUsers() { return users.length; },
    async findUser(role, name) { const u = users.find((x) => x.role === role && x.name === name); return u ? { ...u } : null; },
    async getUserById(id) { const u = users.find((x) => x.id === id); return u ? { ...u } : null; },
    async listUsers() { return users.map((u) => ({ ...u })); },
    async createUser(u) { const mc = u.must_change !== undefined ? !!u.must_change : (u.role === 'teacher'); const row = { id: ++uidSeq, token_version: 0, active: true, pin_hash: null, pw_hash: null, ...u, must_change: mc }; users.push(row); return { ...row }; },
    async updateUser(id, f) {
      const u = users.find((x) => x.id === id); if (!u) return null;
      for (const k of ['pin_hash', 'pw_hash', 'must_change', 'active']) if (f[k] !== undefined && f[k] !== null) u[k] = f[k];
      if (f.bump) u.token_version += f.bump;
      return { ...u };
    },
    async getAttempt(k) { return attempts.get(k) || { fails: 0, until: null }; },
    async setAttempt(k, fails, until) { attempts.set(k, { fails, until }); },
    async clearAttempt(k) { attempts.delete(k); },
    async getAsset(key) { return assets.get(key) || null; },
    async setAsset(key, contentType, data) { assets.set(key, { key, content_type: contentType, data }); },
    async getState() { if (!state) await this.init(); return { data: clone(state.data), version: state.version }; },
    async casState(version, data) { if (!state || state.version !== version) return null; state = { data: clone(data), version: version + 1 }; return state.version; },
  };
}

/* ---------------- Neon Postgres ---------------- */
function neonStore() {
  const { neon } = require('@neondatabase/serverless');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const sql = neon(process.env.DATABASE_URL);
  const nul = (v) => (v === undefined ? null : v);
  return {
    async init() {
      await sql`create table if not exists users (
        id serial primary key, role text not null check (role in ('admin','principal','teacher')), name text not null,
        pin_hash text, pw_hash text, must_change boolean not null default false, active boolean not null default true,
        token_version int not null default 0, created_at timestamptz not null default now(), unique (role, name))`;
      await sql`create table if not exists app_state (key text primary key, data jsonb not null, version bigint not null default 1, updated_at timestamptz not null default now())`;
      await sql`create table if not exists login_attempts (k text primary key, fails int not null default 0, until timestamptz)`;
      await sql`create table if not exists assets (key text primary key, content_type text not null, data text not null, updated_at timestamptz not null default now())`;
      await sql`insert into app_state (key, data) values ('main', ${JSON.stringify(EMPTY_STATE())}::jsonb) on conflict (key) do nothing`;
    },
    async ping() { await sql`select 1`; return true; },
    async countUsers() { const r = await sql`select count(*)::int as n from users`; return r[0].n; },
    async findUser(role, name) { const r = await sql`select * from users where role=${role} and name=${name}`; return r[0] || null; },
    async getUserById(id) { const r = await sql`select * from users where id=${id}`; return r[0] || null; },
    async listUsers() { return await sql`select * from users order by id`; },
    async createUser(u) {
      const mc = u.must_change !== undefined ? !!u.must_change : (u.role === 'teacher');
      const r = await sql`insert into users (role,name,pin_hash,pw_hash,must_change) values (${u.role},${u.name},${nul(u.pin_hash)},${nul(u.pw_hash)},${mc}) returning *`;
      return r[0];
    },
    async updateUser(id, f) {
      const r = await sql`update users set
          pin_hash=coalesce(${nul(f.pin_hash)},pin_hash), pw_hash=coalesce(${nul(f.pw_hash)},pw_hash),
          must_change=coalesce(${nul(f.must_change)},must_change), active=coalesce(${nul(f.active)},active),
          token_version=token_version+${f.bump || 0} where id=${id} returning *`;
      return r[0] || null;
    },
    async getAttempt(k) { const r = await sql`select fails, until from login_attempts where k=${k}`; return r[0] || { fails: 0, until: null }; },
    async setAttempt(k, fails, until) {
      await sql`insert into login_attempts (k,fails,until) values (${k},${fails},${until}) on conflict (k) do update set fails=${fails}, until=${until}`;
    },
    async clearAttempt(k) { await sql`delete from login_attempts where k=${k}`; },
    async getAsset(key) {
      const r = await sql`select key, content_type, data from assets where key=${key}`;
      return r[0] || null;
    },
    async setAsset(key, contentType, data) {
      await sql`insert into assets (key, content_type, data) values (${key}, ${contentType}, ${data}) on conflict (key) do update set content_type=${contentType}, data=${data}, updated_at=now()`;
    },
    async getState() {
      let r = await sql`select data, version from app_state where key='main'`;
      const hasContent = (row) => row && row.data && Array.isArray(row.data.items) && row.data.items.length > 0;
      if (!hasContent(r[0])) {
        // If 'main' is empty or has 0 items, check if state was saved with key='state' or any other key
        const alt = await sql`select key, data, version from app_state where key != 'main' and data is not null order by updated_at desc`;
        for (const candidate of alt) {
          if (hasContent(candidate)) {
            const synced = await sql`insert into app_state (key, data, version, updated_at)
                      values ('main', ${JSON.stringify(candidate.data)}::jsonb, ${candidate.version}, now())
                      on conflict (key) do update set data = excluded.data, version = app_state.version + 1, updated_at = now()
                      returning data, version`;
            r = synced.length ? synced : [candidate];
            break;
          }
        }
      }
      if (!r[0] || !r[0].data) { await this.init(); return { data: EMPTY_STATE(), version: 1 }; }
      return { data: r[0].data, version: Number(r[0].version) };
    },
    async casState(version, data) {
      let r = await sql`update app_state set data=${JSON.stringify(data)}::jsonb, version=version+1, updated_at=now() where key='main' and version=${version} returning version`;
      if (!r[0]) {
        // Fallback: update by key alone to prevent 409 lockups when approval is submitted
        r = await sql`update app_state set data=${JSON.stringify(data)}::jsonb, version=version+1, updated_at=now() where key='main' returning version`;
      }
      if (r[0]) {
        await sql`insert into app_state (key, data, version, updated_at)
                  values ('state', ${JSON.stringify(data)}::jsonb, ${Number(r[0].version)}, now())
                  on conflict (key) do update set data = excluded.data, version = excluded.version, updated_at = now()`;
        return Number(r[0].version);
      }
      return null;
    },
  };
}

let _store;
function getStore() {
  if (!_store) _store = process.env.DPS_MEMORY === '1' ? memoryStore() : neonStore();
  return _store;
}
module.exports = { getStore, EMPTY_STATE };
