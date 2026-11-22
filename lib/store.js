'use strict';
/* Storage layer. Postgres (Neon) in production; in-memory when DPS_MEMORY=1 (local dev + tests). */

const EMPTY_STATE = () => ({ items: [], uid: 0, bills: [], bid: 0, fac: [], log: [], reqs: [], sessionCfg: null });

/* ---------------- in-memory ---------------- */
function memoryStore() {
  const users = []; let uidSeq = 0;
  const attempts = new Map();
  const assets = new Map();
  const pushSubs = [];
  const auditLogs = [];
  let state = null;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  return {
    async init() { if (!state) state = { data: EMPTY_STATE(), version: 1 }; },
    async ping() { return true; },
    async countUsers() { return users.length; },
    async findUser(role, name) { const u = users.find((x) => x.role === role && x.name === name); return u ? { ...u } : null; },
    async getUserById(id) { const u = users.find((x) => Number(x.id) === Number(id)); return u ? { ...u } : null; },
    async listUsers() { return users.map((u) => ({ ...u })); },
    async createUser(u) { const mc = u.must_change !== undefined ? !!u.must_change : (u.role === 'teacher'); const row = { id: ++uidSeq, token_version: 0, active: true, pin_hash: null, pw_hash: null, ...u, must_change: mc }; users.push(row); return { ...row }; },
    async updateUser(id, f) {
      const u = users.find((x) => Number(x.id) === Number(id)); if (!u) return null;
      for (const k of ['pin_hash', 'pw_hash', 'must_change', 'active']) if (f[k] !== undefined && f[k] !== null) u[k] = f[k];
      if (f.bump) u.token_version += f.bump;
      return { ...u };
    },
    async getAttempt(k) { return attempts.get(k) || { fails: 0, until: null }; },
    async setAttempt(k, fails, until) { attempts.set(k, { fails, until }); },
    async recordAttempt(k) {
      const a = attempts.get(k) || { fails: 0, until: null };
      const fails = a.fails + 1;
      let until = a.until;
      if (fails % 5 === 0) until = new Date(Date.now() + Math.min(900, 30 * Math.pow(2, fails / 5 - 1)) * 1000).toISOString();
      attempts.set(k, { fails, until });
      return { fails, until };
    },
    async clearAttempt(k) { attempts.delete(k); },
    async addAuditLog(userId, role, name, action, details, ip) {
      auditLogs.push({ id: auditLogs.length + 1, user_id: userId, role, name, action, details, ip, created_at: new Date() });
    },
    async getAsset(key) { return assets.get(key) || null; },
    async setAsset(key, contentType, data) { assets.set(key, { key, content_type: contentType, data }); },
    async getStateVersion() { if (!state) await this.init(); return state.version; },
    async getState() { if (!state) await this.init(); return { data: clone(state.data), version: state.version }; },
    async casState(version, data) { if (!state || state.version !== version) return null; state = { data: clone(data), version: version + 1 }; return state.version; },
    async savePushSubscription(userId, role, name, sub) {
      if (!sub || !sub.endpoint || !sub.keys) return false;
      const idx = pushSubs.findIndex((s) => s.endpoint === sub.endpoint);
      const row = { userId, role, name: name || null, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, keys: sub.keys };
      if (idx >= 0) pushSubs[idx] = row;
      else pushSubs.push(row);
      return true;
    },
    async deletePushSubscription(endpoint, userId, role) {
      const idx = pushSubs.findIndex((s) => s.endpoint === endpoint && (role === 'admin' || s.userId === userId));
      if (idx >= 0) { pushSubs.splice(idx, 1); return true; }
      return false;
    },
    async ensurePushTable() {
      return true;
    },
    async getPushSubscriptions(role, name) {
      return pushSubs.filter((s) => {
        if (role && s.role !== role) return false;
        if (name && (!s.name || s.name.trim().toLowerCase() !== name.trim().toLowerCase())) return false;
        return true;
      }).map((s) => ({ ...s }));
    },
  };
}

/* ---------------- Neon Postgres ---------------- */
function neonStore() {
  const { neon } = require('@neondatabase/serverless');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const sql = neon(process.env.DATABASE_URL);
  const nul = (v) => (v === undefined ? null : v);

  // In-memory cache per serverless container
  let _cachedState = null;
  let _cachedStateTime = 0;

  return {
    async init() {
      await sql`create table if not exists users (
        id serial primary key, role text not null check (role in ('admin','principal','teacher')), name text not null,
        pin_hash text, pw_hash text, must_change boolean not null default false, active boolean not null default true,
        token_version int not null default 0, created_at timestamptz not null default now(), unique (role, name))`;
      await sql`create table if not exists app_state (key text primary key, data jsonb not null, version bigint not null default 1, updated_at timestamptz not null default now())`;
      await sql`create table if not exists login_attempts (k text primary key, fails int not null default 0, until timestamptz)`;
      await sql`create table if not exists assets (key text primary key, content_type text not null, data text not null, updated_at timestamptz not null default now())`;
      await sql`create table if not exists push_subscriptions (
        id serial primary key, user_id int not null, role text not null, name text,
        endpoint text not null unique, p256dh text not null, auth text not null,
        created_at timestamptz not null default now())`;
      await sql`create table if not exists audit_logs (
        id serial primary key, user_id int, role text, name text,
        action text not null, details jsonb, ip text,
        created_at timestamptz not null default now())`;
      await sql`insert into app_state (key, data) values ('main', ${JSON.stringify(EMPTY_STATE())}::jsonb) on conflict (key) do nothing`;
    },
    async ping() { await sql`select 1`; return true; },
    async countUsers() {
      const r = await sql`select count(*)::int as c from users`;
      return (r[0] && r[0].c) || 0;
    },
    async findUser(role, name) {
      if (!role || !name) return null;
      const r = await sql`select * from users where role=${role} and name=${name}`;
      return r[0] ? { ...r[0] } : null;
    },
    async getUserById(id) {
      if (!id) return null;
      const r = await sql`select * from users where id=${Number(id)}`;
      return r[0] ? { ...r[0] } : null;
    },
    async listUsers() {
      const rows = await sql`select * from users order by id`;
      return rows.map((u) => ({ ...u }));
    },
    async createUser(u) {
      const mc = u.must_change !== undefined ? !!u.must_change : (u.role === 'teacher');
      const r = await sql`insert into users (role,name,pin_hash,pw_hash,must_change) values (${u.role},${u.name},${nul(u.pin_hash)},${nul(u.pw_hash)},${mc}) returning *`;
      return r[0];
    },
    async updateUser(id, f) {
      const r = await sql`update users set
          pin_hash=coalesce(${nul(f.pin_hash)},pin_hash), pw_hash=coalesce(${nul(f.pw_hash)},pw_hash),
          must_change=coalesce(${nul(f.must_change)},must_change), active=coalesce(${nul(f.active)},active),
          token_version=token_version+${f.bump || 0} where id=${Number(id)} returning *`;
      return r[0] || null;
    },
    async getAttempt(k) {
      const r = await sql`select fails, until from login_attempts where k=${k}`;
      return r[0] || { fails: 0, until: null };
    },
    async setAttempt(k, fails, until) {
      await sql`insert into login_attempts (k,fails,until) values (${k},${fails},${until}) on conflict (k) do update set fails=${fails}, until=${until}`;
    },
    async recordAttempt(k) {
      const r = await sql`insert into login_attempts (k,fails,until) values (${k}, 1, null)
        on conflict (k) do update set
          fails = login_attempts.fails + 1,
          until = case
            when (login_attempts.fails + 1) % 5 = 0
            then now() + (least(900, 30 * power(2, (login_attempts.fails + 1) / 5 - 1)) || ' seconds')::interval
            else login_attempts.until
          end
        returning fails, until`;
      return r[0] || { fails: 1, until: null };
    },
    async clearAttempt(k) {
      await sql`delete from login_attempts where k=${k}`;
    },
    async addAuditLog(userId, role, name, action, details, ip) {
      try {
        await sql`insert into audit_logs (user_id, role, name, action, details, ip)
          values (${userId || null}, ${role || null}, ${name || null}, ${action}, ${JSON.stringify(details || {})}::jsonb, ${ip || null})`;
      } catch (e) {}
    },
    async getAsset(key) {
      const r = await sql`select key, content_type, data from assets where key=${key}`;
      return r[0] || null;
    },
    async setAsset(key, contentType, data) {
      await sql`insert into assets (key, content_type, data) values (${key}, ${contentType}, ${data}) on conflict (key) do update set content_type=${contentType}, data=${data}, updated_at=now()`;
    },
    async getStateVersion() {
      if (_cachedState && Date.now() - _cachedStateTime < 10000) return _cachedState.version;
      const r = await sql`select version from app_state where key='main'`;
      return r[0] ? Number(r[0].version) : 1;
    },
    async getState() {
      if (_cachedState && Date.now() - _cachedStateTime < 10000) {
        return { data: JSON.parse(JSON.stringify(_cachedState.data)), version: _cachedState.version };
      }
      let r = await sql`select data, version from app_state where key='main'`;
      const hasContent = (row) => row && row.data && Array.isArray(row.data.items) && row.data.items.length > 0;
      if (!hasContent(r[0])) {
        const alt = await sql`select key, data, version from app_state where key != 'main' and data is not null order by updated_at desc limit 1`;
        if (hasContent(alt[0])) {
          const synced = await sql`insert into app_state (key, data, version, updated_at)
                    values ('main', ${JSON.stringify(alt[0].data)}::jsonb, ${alt[0].version}, now())
                    on conflict (key) do update set data = excluded.data, version = app_state.version + 1, updated_at = now()
                    returning data, version`;
          r = synced.length ? synced : alt;
        }
      }
      if (!r[0] || !r[0].data) { await this.init(); return { data: EMPTY_STATE(), version: 1 }; }
      const resObj = { data: r[0].data, version: Number(r[0].version) };
      _cachedState = resObj;
      _cachedStateTime = Date.now();
      return { data: JSON.parse(JSON.stringify(resObj.data)), version: resObj.version };
    },
    async casState(version, data) {
      const r = await sql`update app_state set data=${JSON.stringify(data)}::jsonb, version=version+1, updated_at=now() where key='main' and version=${version} returning version`;
      if (r[0]) {
        _cachedState = { data, version: Number(r[0].version) };
        _cachedStateTime = Date.now();
        return Number(r[0].version);
      }
      _cachedState = null; _cachedStateTime = 0;
      return null;
    },
    async ensurePushTable() {
      await sql`create table if not exists push_subscriptions (
        id serial primary key,
        user_id int not null,
        role text not null,
        name text,
        endpoint text not null unique,
        p256dh text not null,
        auth text not null,
        created_at timestamptz not null default now()
      )`;
    },
    async savePushSubscription(userId, role, name, sub) {
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return false;
      try {
        await sql`insert into push_subscriptions (user_id, role, name, endpoint, p256dh, auth)
          values (${userId}, ${role}, ${name || null}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
          on conflict (endpoint) do update set user_id=excluded.user_id, role=excluded.role, name=excluded.name, p256dh=excluded.p256dh, auth=excluded.auth`;
        return true;
      } catch (err) {
        if (err && String(err.message || '').includes('push_subscriptions')) {
          await this.ensurePushTable().catch(() => {});
          await sql`insert into push_subscriptions (user_id, role, name, endpoint, p256dh, auth)
            values (${userId}, ${role}, ${name || null}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
            on conflict (endpoint) do update set user_id=excluded.user_id, role=excluded.role, name=excluded.name, p256dh=excluded.p256dh, auth=excluded.auth`;
          return true;
        }
        throw err;
      }
    },
    async deletePushSubscription(endpoint, userId, role) {
      if (!endpoint) return false;
      try {
        const r = role === 'admin'
          ? await sql`delete from push_subscriptions where endpoint=${endpoint} returning id`
          : await sql`delete from push_subscriptions where endpoint=${endpoint} and user_id=${userId} returning id`;
        return r.length > 0;
      } catch (err) {
        if (err && String(err.message || '').includes('push_subscriptions')) return false;
        throw err;
      }
    },
    async getPushSubscriptions(role, name) {
      try {
        let rows;
        if (role && name) {
          rows = await sql`select user_id as "userId", role, name, endpoint, p256dh, auth from push_subscriptions where role=${role} and lower(trim(name))=lower(trim(${name}))`;
        } else if (role) {
          rows = await sql`select user_id as "userId", role, name, endpoint, p256dh, auth from push_subscriptions where role=${role}`;
        } else {
          rows = await sql`select user_id as "userId", role, name, endpoint, p256dh, auth from push_subscriptions`;
        }
        return rows.map((r) => ({ ...r, keys: { p256dh: r.p256dh, auth: r.auth } }));
      } catch (err) {
        if (err && String(err.message || '').includes('push_subscriptions')) {
          await this.ensurePushTable().catch(() => {});
          return [];
        }
        throw err;
      }
    },
  };
}

let _store;
function getStore() {
  if (!_store) _store = process.env.DPS_MEMORY === '1' ? memoryStore() : neonStore();
  return _store;
}
module.exports = { getStore, EMPTY_STATE };
