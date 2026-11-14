'use strict';
/* Pure rules for who may change what inside the shared inventory document. */

const RANK = { Pending: 0, Verified: 1, Approved: 2, Declined: 2 };
const rank = (st) => (st in RANK ? RANK[st] : 0);
const isArr = Array.isArray;
const isObj = (x) => x && typeof x === 'object' && !isArr(x);
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

function normalize(d) {
  d = isObj(d) ? d : {};
  const reqs = (isArr(d.reqs) ? d.reqs : []).map((r) => {
    if (!isObj(r)) return r;
    const iss = isArr(r.iss) ? r.iss : (r.iss && typeof r.iss === 'object' ? Object.values(r.iss) : (r.iss != null ? [r.iss] : r.iss));
    const ret = isArr(r.ret) ? r.ret : (r.ret && typeof r.ret === 'object' ? Object.values(r.ret) : (r.ret != null ? [r.ret] : r.ret));
    const rejP = isArr(r.rejP) ? r.rejP : (r.rejP && typeof r.rejP === 'object' ? Object.values(r.rejP) : []);
    const rejA = isArr(r.rejA) ? r.rejA : (r.rejA && typeof r.rejA === 'object' ? Object.values(r.rejA) : []);
    return { ...r, iss, ret, rejP, rejA };
  });
  return {
    items: isArr(d.items) ? d.items : [], uid: +d.uid || 0,
    bills: isArr(d.bills) ? d.bills : [], bid: +d.bid || 0,
    fac: isArr(d.fac) ? d.fac : [], log: isArr(d.log) ? d.log : [],
    reqs, sessionCfg: isObj(d.sessionCfg) ? d.sessionCfg : null,
  };
}
const maxReqId = (reqs) => reqs.reduce((m, r) => Math.max(m, +r.id || 0), 0);
const sortReqs = (reqs) => reqs.slice().sort((a, b) => (b.id || 0) - (a.id || 0));

/* what each role is allowed to see */
function viewFor(user, state) {
  const s = normalize(state);
  const out = user.role === 'teacher'
    ? { items: s.items, uid: s.uid, bills: [], bid: 0, fac: [], log: [], reqs: s.reqs.filter((r) => r.by === user.name), sessionCfg: s.sessionCfg }
    : s;
  return { ...out, reqSeq: maxReqId(s.reqs) };
}

/* admin: owns items/bills/faculty/log/settings. Slips are merged so nothing a teacher or the principal did meanwhile is lost. */
function applyAdmin(server, client) {
  const s = normalize(server), c = normalize(client);
  const byId = new Map(s.reqs.map((r) => [r.id, r]));
  const merged = new Map(byId);
  for (const r of c.reqs) {
    const cur = byId.get(r.id);
    if (!cur) { if (isObj(r) && r.id != null) merged.set(r.id, r); continue; }   // admin-created (rare)
    merged.set(r.id, rank(r.st) >= rank(cur.st) ? r : cur);                       // never move a slip backwards
  }
  return { ...c, reqs: sortReqs([...merged.values()]) };
}

/* principal: may only move a Pending slip to Verified or Declined */
function applyPrincipal(server, clientReqs) {
  const s = normalize(server);
  const cmap = new Map((isArr(clientReqs) ? clientReqs : []).map((r) => [String(r.id), r]));
  const reqs = s.reqs.map((cur) => {
    const nw = cmap.get(String(cur.id));
    if (!nw) return cur;
    const curSt = String(cur.st || cur.status || '').trim();
    const nwSt = String(nw.st || nw.status || '').trim();
    if (!curSt.toLowerCase().startsWith('pend')) return cur;
    if (!nwSt.toLowerCase().startsWith('verif') && !nwSt.toLowerCase().startsWith('appr') && !nwSt.toLowerCase().startsWith('decl')) return cur;
    const finalSt = nwSt.toLowerCase().startsWith('decl') ? 'Declined' : 'Verified';
    return {
      ...cur,
      ...nw,
      id: cur.id,
      by: cur.by,
      date: cur.date,
      purpose: cur.purpose || nw.purpose,
      st: finalSt,
      status: finalSt,
      pDate: nw.pDate || todayIST(),
      rejP: isArr(nw.rejP) ? nw.rejP : (cur.rejP || [])
    };
  });
  return { ...s, reqs };
}

/* teacher: may only add brand-new Pending slips under their own name */
function cleanLines(it, itemIds) {
  if (!isArr(it) || !it.length || it.length > 80) return null;
  const out = [];
  for (const l of it) {
    if (!isArr(l) || l.length < 3) return null;
    const id = Math.trunc(+l[0]), q = Math.trunc(+l[2]), v = String(l[1] == null ? '' : l[1]).slice(0, 80);
    if (!itemIds.has(id) || !(q >= 1 && q <= 100000)) return null;
    out.push([id, v, q]);
  }
  return out;
}
function applyTeacher(server, clientReqs, name) {
  const s = normalize(server);
  const taken = new Set(s.reqs.map((r) => r.id));
  const own = new Set(s.reqs.filter((r) => r.by === name).map((r) => r.id));
  const itemIds = new Set(s.items.map((i) => i.id));
  const added = [], assigned = {};
  let next = maxReqId(s.reqs);
  for (const r of isArr(clientReqs) ? clientReqs : []) {
    if (!isObj(r) || r.by !== name || r.st !== 'Pending' || own.has(r.id)) continue;
    const it = cleanLines(r.it, itemIds); if (!it) continue;
    let id = Math.trunc(+r.id);
    if (!(id > 0) || taken.has(id)) id = ++next;
    taken.add(id); next = Math.max(next, id);
    if (id !== r.id) assigned[r.id] = id;
    added.push({ id, by: name, it, st: 'Pending', date: todayIST(), purpose: String(r.purpose || '').slice(0, 200) });
  }
  return { state: { ...s, reqs: sortReqs([...added, ...s.reqs]) }, assigned, added: added.length };
}

module.exports = { normalize, viewFor, applyAdmin, applyPrincipal, applyTeacher, maxReqId, rank };
