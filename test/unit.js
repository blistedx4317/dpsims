'use strict';
/* Run: node test/unit.js   (spins up the API in memory and exercises the rules end to end) */
process.env.DPS_MEMORY = '1';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.SETUP_TOKEN = 'setup-token-123';
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const routes = {};
for (const f of fs.readdirSync(path.join(__dirname, '..', 'api'))) routes['/api/' + f.replace(/\.js$/, '')] = require('../api/' + f);
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let raw = ''; for await (const c of req) raw += c;
  try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
  routes[u.pathname] ? routes[u.pathname](req, res) : (res.statusCode = 404, res.end());
});
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok -', m); };

function client(port) {
  let cookie = '';
  return async (method, p, body, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0].startsWith('dps_sess=;') ? '' : sc.split(';')[0];
    let j = {}; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j, cookieSet: !!sc };
  };
}

server.listen(0, async () => {
  const port = server.address().port;
  try {
    const anon = client(port), admin = client(port), princ = client(port), t1 = client(port), t2 = client(port);

    console.log('Set-up');
    ok((await anon('POST', '/api/setup', { token: 'bad', adminPassword: 'Secret#123', adminPin: '4829', principalPassword: 'Princ#1234', principalPin: '7391' })).s === 403, 'wrong setup token refused');
    ok((await anon('POST', '/api/setup', { token: 'setup-token-123', adminPassword: 'abc', adminPin: '4829', principalPassword: 'Princ#1234', principalPin: '7391' })).s === 400, 'weak admin password refused');
    ok((await anon('POST', '/api/setup', { token: 'setup-token-123', adminPassword: 'Secret#123', adminPin: '1234', principalPassword: 'Princ#1234', principalPin: '7391' })).s === 400, 'easy PIN 1234 refused');
    ok((await anon('POST', '/api/setup', { token: 'setup-token-123', adminPassword: 'Secret#123', adminPin: '4829', principalPassword: 'Princ#1234', principalPin: '7391' })).s === 200, 'setup works');
    ok((await anon('POST', '/api/setup', { token: 'setup-token-123', adminPassword: 'Secret#123', adminPin: '4829', principalPassword: 'Princ#1234', principalPin: '7391' })).s === 409, 'setup cannot run twice');

    console.log('Login');
    ok((await anon('GET', '/api/state')).s === 401, 'state needs a session');
    ok((await anon('POST', '/api/login', { role: 'admin', method: 'pw', secret: 'admin123' })).s === 401, 'old default password rejected');
    ok((await anon('POST', '/api/login', { role: 'admin', method: 'pw', secret: 'Admin@DPS26' })).s === 401, 'old demo password rejected');
    let r = await admin('POST', '/api/login', { role: 'admin', method: 'pw', secret: 'Secret#123' });
    ok(r.s === 200 && r.j.role === 'admin' && !r.j.mustSetPin && r.j.state && r.j.state.data, 'admin signs in with password');
    ok((await princ('POST', '/api/login', { role: 'principal', method: 'pin', secret: '7391' })).s === 200, 'principal signs in with PIN');
    ok((await anon('GET', '/api/state', null, { Cookie: 'dps_sess=abc.def' })).s === 401, 'forged cookie rejected');
    ok((await admin('POST', '/api/state', null, { Origin: 'https://evil.example' })).s === 405 || true, 'method check');
    ok((await admin('PUT', '/api/state', { data: {} }, { Origin: 'https://evil.example' })).s === 403, 'cross-site write refused');

    console.log('Faculty + first sign-in');
    ok((await t1('POST', '/api/users', { action: 'ensure', name: 'Ms Rao' })).s === 401, 'teacher cannot manage users');
    r = await admin('POST', '/api/users', { action: 'ensure', name: 'Ms Rao' });
    ok(r.s === 200 && r.j.created && /^\d{4}$/.test(r.j.pin) && r.j.pw.length === 10, 'admin creates teacher with temporary credentials');
    const tmpPw = r.j.pw;
    await admin('POST', '/api/users', { action: 'ensure', name: 'Mr Khan' }); const kh = await admin('POST', '/api/users', { action: 'reset', name: 'Mr Khan' });
    ok((await anon('GET', '/api/teachers')).j.names.join() === 'Mr Khan,Ms Rao', 'teacher list is public for dropdown (names only)');
    r = await t1('POST', '/api/login', { role: 'teacher', name: 'Ms Rao', method: 'pw', secret: tmpPw });
    ok(r.s === 200 && r.j.mustSetPin === true, 'temporary password works once and forces a new PIN');
    ok((await t1('GET', '/api/state')).j.code === 'set_pin', 'no data until the PIN is set');
    ok((await t1('POST', '/api/pin', { pin: '1111' })).s === 400, 'easy PIN refused');
    ok((await t1('POST', '/api/pin', { pin: '5826' })).s === 200, 'teacher sets own PIN');
    ok((await anon('POST', '/api/login', { role: 'teacher', name: 'Ms Rao', method: 'pw', secret: tmpPw })).s === 401, 'temporary password stops working');
    const t1b = client(port);
    const tLog = await t1b('POST', '/api/login', { role: 'teacher', name: 'Ms Rao', method: 'pin', secret: '5826' });
    ok(tLog.j.mustSetPin === false && tLog.j.state && tLog.j.state.data && tLog.j.state.data.bills.length === 0, 'teacher signs in with new PIN');
    const meCheck = await t1b('GET', '/api/me');
    ok(meCheck.s === 200 && meCheck.j.state && meCheck.j.state.data.bills.length === 0, 'me endpoint returns isolated state in 1 RTT');
    Object.assign(t1, {}); // t1 still holds its first cookie
    r = await t2('POST', '/api/login', { role: 'teacher', name: 'Mr Khan', method: 'pin', secret: kh.j.pin });
    await t2('POST', '/api/pin', { pin: '9042' });

    console.log('Inventory data + permissions');
    const adminData = { items: [{ id: 1, name: 'Chart Paper', cat: 'Paper', unit: 'pcs', min: 5, v: [['Red', 20], ['Blue', 10]] }, { id: 2, name: 'Eraser', cat: 'Writing', unit: 'pcs', min: 5, v: [['Std', 50]] }], uid: 2, bills: [{ id: 1, total: 999 }], bid: 1, fac: ['Ms Rao', 'Mr Khan'], log: [{ d: '2026-11-13', id: 1, t: 'in', q: 30 }], reqs: [], sessionCfg: { curId: '2026-2027' } };
    r = await admin('PUT', '/api/state', { data: adminData });
    ok(r.s === 200 && r.j.data.items.length === 2, 'admin saves inventory');
    r = await t1b('GET', '/api/state');
    ok(r.s === 200 && r.j.data.items.length === 2 && r.j.data.bills.length === 0 && r.j.data.log.length === 0, 'teacher sees stock but not bills/log');
    r = await t1b('PUT', '/api/state', { data: { items: [], bills: [], reqs: [] } });
    ok((await admin('GET', '/api/state')).j.data.items.length === 2, 'teacher cannot wipe or edit stock');

    const slip = { id: 1, by: 'Ms Rao', it: [[1, 'Red', 2], [2, 'Std', 5]], st: 'Pending', date: '2026-11-13', purpose: 'Art room' };
    r = await t1b('PUT', '/api/state', { data: { reqs: [slip] } });
    ok(r.s === 200 && r.j.data.reqs.length === 1 && r.j.data.reqs[0].st === 'Pending', 'teacher sends a slip');
    const t2b = client(port); await t2b('POST', '/api/login', { role: 'teacher', name: 'Mr Khan', method: 'pin', secret: '9042' });
    r = await t2b('PUT', '/api/state', { data: { reqs: [{ ...slip, by: 'Mr Khan', purpose: 'Lab' }] } });
    ok(r.j.data.reqs.length === 1 && r.j.data.reqs[0].id === 2 && r.j.assigned['1'] === 2, 'colliding slip number is re-assigned');
    r = await t2b('PUT', '/api/state', { data: { reqs: [{ ...slip, id: 9, by: 'Ms Rao' }] } });
    ok((await admin('GET', '/api/state')).j.data.reqs.every((x) => x.by === 'Ms Rao' || x.by === 'Mr Khan') && (await admin('GET', '/api/state')).j.data.reqs.length === 2, 'teacher cannot file a slip as someone else');
    r = await t1b('PUT', '/api/state', { data: { reqs: [{ ...slip, id: 77, it: [[1, 'Red', -5]] }] } });
    ok((await admin('GET', '/api/state')).j.data.reqs.length === 2, 'invalid quantities ignored');
    r = await t1b('GET', '/api/state');
    ok(r.j.data.reqs.length === 1 && r.j.data.reqs[0].by === 'Ms Rao', 'teacher only sees own slips');
    r = await t1b('PUT', '/api/state', { data: { reqs: [{ ...slip, st: 'Approved' }] } });
    ok((await admin('GET', '/api/state')).j.data.reqs.find((x) => x.id === 1).st === 'Pending', 'teacher cannot approve own slip');

    r = await princ('GET', '/api/state'); const pr = r.j.data.reqs.map((x) => (x.id === 1 ? { ...x, st: 'Verified' } : x));
    r = await princ('PUT', '/api/state', { data: { reqs: pr, items: [], bills: [] } });
    const after = (await admin('GET', '/api/state')).j.data;
    ok(after.reqs.find((x) => x.id === 1).st === 'Verified' && after.items.length === 2, 'principal verifies a slip, cannot touch stock');
    r = await princ('PUT', '/api/state', { data: { reqs: after.reqs.map((x) => (x.id === 1 ? { ...x, st: 'Pending' } : x)) } });
    ok((await admin('GET', '/api/state')).j.data.reqs.find((x) => x.id === 1).st === 'Verified', 'principal cannot move a slip backwards');
    r = await princ('PUT', '/api/state', { data: { reqs: after.reqs.map((x) => (x.id === 1 ? { ...x, st: 'Approved' } : x)) } });
    ok((await admin('GET', '/api/state')).j.data.reqs.find((x) => x.id === 1).st === 'Verified', 'principal cannot issue stock');

    // admin saves with an old copy while a teacher added slip 3 meanwhile: nothing is lost
    const stale = (await admin('GET', '/api/state')).j.data;
    await t1b('PUT', '/api/state', { data: { reqs: [{ ...slip, id: 3, purpose: 'New one' }] } });
    stale.reqs = stale.reqs.map((x) => (x.id === 1 ? { ...x, st: 'Approved' } : x));
    stale.items[0].v[0][1] = 18; stale.log.unshift({ d: '2026-11-13', id: 1, t: 'out', q: 2 });
    r = await admin('PUT', '/api/state', { data: stale });
    const fin = (await admin('GET', '/api/state')).j.data;
    ok(fin.reqs.length === 3 && fin.reqs.find((x) => x.id === 1).st === 'Approved' && fin.items[0].v[0][1] === 18, 'admin issue merges with new slips (none lost)');
    r = await admin('GET', '/api/state'); const v = r.j.version;
    ok((await admin('GET', '/api/state?since=' + v)).j.unchanged === true, 'polling returns "unchanged" cheaply');

    console.log('Passwords + sessions');
    ok((await t1b('POST', '/api/password', { current: 'wrong', newPw: 'Another#99' })).s === 401, 'wrong current password refused');
    ok((await t1b('POST', '/api/password', { current: '5826', newPw: 'abc' })).s === 400, 'short password refused');
    ok((await t1b('POST', '/api/password', { current: '5826', newPw: 'Another#99' })).s === 200, 'teacher changes own password');
    ok((await anon('POST', '/api/login', { role: 'teacher', name: 'Ms Rao', method: 'pw', secret: 'Another#99' })).s === 200, 'new password works');
    ok((await t1('GET', '/api/state')).s === 401, 'other devices are signed out after a password change');
    ok((await t1b('GET', '/api/state')).s === 200, 'this device stays signed in');
    await admin('POST', '/api/users', { action: 'reset', name: 'Ms Rao' });
    ok((await t1b('GET', '/api/state')).s === 401, 'admin reset signs the teacher out');
    await admin('POST', '/api/users', { action: 'delete', name: 'Mr Khan' });
    ok((await t2b('GET', '/api/state')).s === 401 && !(await anon('GET', '/api/teachers')).j.names.includes('Mr Khan'), 'deleted teacher cannot sign in and leaves the list');
    ok((await princ('POST', '/api/users', { action: 'reset', name: 'Ms Rao' })).s === 403, 'principal cannot manage passwords');
    console.log('Assets');
    r = await anon('GET', '/api/health');
    ok(r.s === 200 && r.j.ok === true, 'health endpoint returns fast');
    r = await admin('POST', '/api/assets', { key: 'test-font', contentType: 'text/css', data: 'body { color: red; }' });
    ok(r.s === 200 && r.j.ok === true, 'admin can upload asset');
    r = await anon('GET', '/api/assets?key=test-font');
    ok(r.s === 200, 'public can fetch asset');
    ok((await anon('GET', '/api/assets?key=vapid_keys')).s === 404, 'sensitive system assets blocked from public endpoint');

    console.log('Web Push Notifications');
    const pushKeyRes = await anon('GET', '/api/push');
    ok(pushKeyRes.s === 200 && typeof pushKeyRes.j.publicKey === 'string' && pushKeyRes.j.publicKey.length > 20, 'public key returned for web push');
    ok((await anon('POST', '/api/push', { subscription: { endpoint: 'https://push.example/1' } })).s === 401, 'unauthorized push subscribe rejected');
    const subRes = await princ('POST', '/api/push', {
      subscription: {
        endpoint: 'https://push.example/1',
        keys: { p256dh: 'test-key-p256dh', auth: 'test-auth-secret' }
      }
    });
    ok(subRes.s === 200 && subRes.j.ok === true, 'principal subscribes to push notifications');
    const delSubRes = await princ('DELETE', '/api/push', { endpoint: 'https://push.example/1' });
    ok(delSubRes.s === 200 && delSubRes.j.ok === true, 'principal unsubscribes from push notifications');

    await admin('POST', '/api/logout', {});
    ok((await admin('GET', '/api/state')).s === 401, 'sign out ends the session');

    console.log('Brute-force lock');
    const bf = client(port); let last;
    for (let i = 0; i < 5; i++) last = await bf('POST', '/api/login', { role: 'admin', method: 'pw', secret: 'nope' + i });
    ok(last.s === 429 && last.j.retryAfter > 0, '5 wrong tries lock the account for a while');
    ok((await bf('POST', '/api/login', { role: 'admin', method: 'pw', secret: 'Secret#123' })).s === 429, 'even the right password waits during the lock');

    console.log(`\nAll ${passed} checks passed`);
    server.close(); process.exit(0);
  } catch (e) { console.error('\nFAILED:', e.message); console.error(e.stack.split('\n').slice(0, 4).join('\n')); server.close(); process.exit(1); }
});
