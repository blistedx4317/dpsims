'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const MAX_AGE = 12 * 3600; // 12 hours
const TRUST_MAX_AGE = 30 * 24 * 3600; // 30 days for trusted device cookie

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (at least 32 characters)');
  return s;
}

async function hashSecret(s) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(String(s), salt, 32);
  return salt.toString('hex') + ':' + h.toString('hex');
}
async function verifySecret(s, stored) {
  if (!stored || typeof s !== 'string') return false;
  const [salt, h] = stored.split(':');
  if (!salt || !h) return false;
  const d = await scrypt(s, Buffer.from(salt, 'hex'), 32);
  const hb = Buffer.from(h, 'hex');
  return hb.length === d.length && crypto.timingSafeEqual(hb, d);
}
/* burn the same time when the user does not exist, so timing does not reveal valid names */
const DUMMY = '00000000000000000000000000000000:' + '00'.repeat(32);
async function dummyVerify(s) { await verifySecret(String(s), DUMMY); }

function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(b).digest('base64url');
  return b + '.' + sig;
}
function verifyToken(t) {
  if (typeof t !== 'string' || t.indexOf('.') < 0) return null;
  const [b, sig] = t.split('.');
  const exp = crypto.createHmac('sha256', secret()).update(b).digest('base64url');
  const a = Buffer.from(sig || ''), e = Buffer.from(exp);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (!p || typeof p.e !== 'number' || p.e < Date.now()) return null;
    return p;
  } catch (e2) { return null; }
}

/* Cookie name: __Host- prefix when served over HTTPS (production/Vercel) */
function isHttpsRequest(req) {
  return !!(process.env.VERCEL || (req && (req.headers && (req.headers['x-forwarded-proto'] === 'https') || (req.connection && req.connection.encrypted))));
}
function cookieName(req) {
  return isHttpsRequest(req) ? '__Host-dps_sess' : 'dps_sess';
}
function trustCookieName(req) {
  return isHttpsRequest(req) ? '__Host-dps_trust' : 'dps_trust';
}

function makeCookie(user, req) {
  const name = cookieName(req);
  const t = sign({ u: user.id, v: user.token_version, e: Date.now() + MAX_AGE * 1000 });
  const secure = isHttpsRequest(req) ? 'Secure; ' : '';
  return `${name}=${t}; HttpOnly; ${secure}SameSite=Strict; Path=/; Max-Age=${MAX_AGE}`;
}
function clearCookie(req) {
  const name = cookieName(req);
  const secure = isHttpsRequest(req) ? 'Secure; ' : '';
  return `${name}=; HttpOnly; ${secure}SameSite=Strict; Path=/; Max-Age=0`;
}
function makeTrustCookie(user, req) {
  const name = trustCookieName(req);
  const t = sign({ u: user.id, trust: true, e: Date.now() + TRUST_MAX_AGE * 1000 });
  const secure = isHttpsRequest(req) ? 'Secure; ' : '';
  return `${name}=${t}; HttpOnly; ${secure}SameSite=Strict; Path=/; Max-Age=${TRUST_MAX_AGE}`;
}
function isTrustedDevice(userId, req) {
  const h = req && req.headers && req.headers.cookie; if (!h) return false;
  const targetNames = ['__Host-dps_trust', 'dps_trust'];
  let val = null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && targetNames.includes(part.slice(0, i).trim())) {
      val = part.slice(i + 1).trim();
      break;
    }
  }
  if (!val) return false;
  const p = verifyToken(val);
  return !!(p && p.trust && p.u === userId);
}

function readCookie(req) {
  const h = req && req.headers && req.headers.cookie; if (!h) return null;
  const targetNames = ['__Host-dps_sess', 'dps_sess'];
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && targetNames.includes(part.slice(0, i).trim())) return part.slice(i + 1).trim();
  }
  return null;
}
/* returns the live user row for a valid session, or null */
async function sessionUser(req, store) {
  const p = verifyToken(readCookie(req)); if (!p) return null;
  const u = await store.getUserById(p.u);
  if (!u || !u.active || u.token_version !== p.v) return null;
  return u;
}

/* ---- credential rules ---- */
const PIN_BLOCKLIST = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '3210', '9876', '6789', '2580', '0852', '1379', '9731',
  '1212', '6969', '1122', '1313', '2020', '2024', '2025', '2026'
]);
function pinProblem(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return 'PIN must be exactly 4 digits.';
  if (/^(\d)\1{3}$/.test(pin) || '01234567890'.includes(pin) || '09876543210'.includes(pin) || PIN_BLOCKLIST.has(pin)) {
    return 'Too easy to guess. Choose a different PIN.';
  }
  return null;
}
function passwordProblem(pw, role = 'teacher') {
  if (typeof pw !== 'string') return 'Password must be a string.';
  if (role === 'admin' || role === 'principal') {
    if (pw.length < 12) return `${role === 'admin' ? 'Admin' : 'Principal'} password must be at least 12 characters long.`;
    if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) {
      return 'Password must contain uppercase, lowercase, numbers, and special characters.';
    }
  } else {
    if (pw.length < 8) return 'Password must be at least 8 characters long.';
  }
  if (pw.length > 100) return 'Password is too long.';
  return null;
}
function tempPin() { let p; do { p = String(crypto.randomInt(0, 10000)).padStart(4, '0'); } while (pinProblem(p)); return p; }
function tempPassword(role = 'teacher') {
  const lower = 'abcdefghjkmnpqrstuvwxyz', upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', digits = '23456789', sym = '!@#$%^&*';
  const all = lower + upper + digits + sym;
  let s = '';
  const len = (role === 'admin' || role === 'principal') ? 14 : 10;
  s += lower[crypto.randomInt(0, lower.length)];
  s += upper[crypto.randomInt(0, upper.length)];
  s += digits[crypto.randomInt(0, digits.length)];
  s += sym[crypto.randomInt(0, sym.length)];
  for (let i = s.length; i < len; i++) s += all[crypto.randomInt(0, all.length)];
  return s;
}

/* ---- atomic rate limiting with progressive lockout ---- */
async function checkLock(store, key) {
  const a = await store.getAttempt(key);
  if (a.until && new Date(a.until).getTime() > Date.now()) return Math.ceil((new Date(a.until).getTime() - Date.now()) / 1000);
  return 0;
}
async function checkProgressiveLock(store, ipKey, acctKey) {
  const [waitIp, waitAcct] = await Promise.all([
    checkLock(store, ipKey),
    acctKey ? checkLock(store, acctKey) : 0
  ]);
  return Math.max(waitIp, waitAcct);
}
async function recordFail(store, key) {
  const res = await store.recordAttempt(key);
  const now = Date.now();
  const until = res && res.until ? new Date(res.until).getTime() : 0;
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}
async function recordProgressiveFail(store, ipKey, acctKey) {
  const [resIp, resAcct] = await Promise.all([
    store.recordAttempt(ipKey),
    acctKey ? store.recordAttempt(acctKey) : { until: null }
  ]);
  const now = Date.now();
  const untilIp = resIp && resIp.until ? new Date(resIp.until).getTime() : 0;
  const untilAcct = resAcct && resAcct.until ? new Date(resAcct.until).getTime() : 0;
  const maxUntil = Math.max(untilIp, untilAcct);
  return maxUntil > now ? Math.ceil((maxUntil - now) / 1000) : 0;
}
async function clearProgressiveAttempts(store, ipKey, acctKey) {
  await Promise.all([
    store.clearAttempt(ipKey).catch(() => {}),
    acctKey ? store.clearAttempt(acctKey).catch(() => {}) : null
  ]);
}

module.exports = {
  hashSecret, verifySecret, dummyVerify, sign, verifyToken,
  makeCookie, clearCookie, readCookie, makeTrustCookie, isTrustedDevice,
  sessionUser, pinProblem, passwordProblem, tempPin, tempPassword,
  checkLock, recordFail, checkProgressiveLock, recordProgressiveFail, clearProgressiveAttempts
};
