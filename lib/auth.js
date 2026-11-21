'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const COOKIE = 'dps_sess';
const MAX_AGE = 12 * 3600; // 12 hours

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
function makeCookie(user) {
  const t = sign({ u: user.id, v: user.token_version, e: Date.now() + MAX_AGE * 1000 });
  return `${COOKIE}=${t}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}`;
}
function clearCookie() { return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`; }
function readCookie(req) {
  const h = req.headers && req.headers.cookie; if (!h) return null;
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim(); }
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
function pinProblem(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return 'PIN must be exactly 4 digits.';
  if (/^(\d)\1{3}$/.test(pin) || '01234567890'.includes(pin) || '09876543210'.includes(pin) || pin === '1234') return 'Too easy to guess. Choose a different PIN.';
  return null;
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 6) return 'Password must be at least 6 characters long.';
  if (pw.length > 100) return 'Password is too long.';
  return null;
}
function tempPin() { let p; do { p = String(crypto.randomInt(0, 10000)).padStart(4, '0'); } while (pinProblem(p)); return p; }
function tempPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 10; i++) s += a[crypto.randomInt(0, a.length)];
  return s;
}

/* ---- brute-force limiter: 5 wrong tries -> wait 30s, doubling each round (max 15 min) ---- */
async function checkLock(store, key) {
  const a = await store.getAttempt(key);
  if (a.until && new Date(a.until).getTime() > Date.now()) return Math.ceil((new Date(a.until).getTime() - Date.now()) / 1000);
  return 0;
}
async function recordFail(store, key) {
  const a = await store.getAttempt(key); const fails = (a.fails || 0) + 1; let until = null;
  if (fails % 5 === 0) until = new Date(Date.now() + Math.min(900, 30 * Math.pow(2, fails / 5 - 1)) * 1000).toISOString();
  await store.setAttempt(key, fails, until);
  return until ? Math.ceil((new Date(until).getTime() - Date.now()) / 1000) : 0;
}

/* Progressive rate limiting: dual-lock on both IP and Account level */
async function checkProgressiveLock(store, ipKey, acctKey) {
  const [waitIp, waitAcct] = await Promise.all([
    checkLock(store, ipKey),
    acctKey ? checkLock(store, acctKey) : 0
  ]);
  return Math.max(waitIp, waitAcct);
}
async function recordProgressiveFail(store, ipKey, acctKey) {
  const [wIp, wAcct] = await Promise.all([
    recordFail(store, ipKey),
    acctKey ? recordFail(store, acctKey) : 0
  ]);
  return Math.max(wIp, wAcct);
}
async function clearProgressiveAttempts(store, ipKey, acctKey) {
  await Promise.all([
    store.clearAttempt(ipKey).catch(() => {}),
    acctKey ? store.clearAttempt(acctKey).catch(() => {}) : null
  ]);
}

module.exports = { hashSecret, verifySecret, dummyVerify, sign, verifyToken, makeCookie, clearCookie, readCookie, sessionUser, pinProblem, passwordProblem, tempPin, tempPassword, checkLock, recordFail, checkProgressiveLock, recordProgressiveFail, clearProgressiveAttempts };
