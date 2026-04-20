import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { scrypt, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { getRedis, isRedisConfigured } from './redis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
const REGISTRATIONS_FILE = path.join(DATA_DIR, 'registrations.json');
const REDIS_KEY = 'vajb:students';
const REDIS_REG_KEY = 'vajb:registrations';
const MAX_STUDENTS = (() => { const v = parseInt(process.env.MAX_STUDENTS); return Number.isFinite(v) && v > 0 ? v : 10000; })();
const MAX_REG_PER_IP = (() => { const v = parseInt(process.env.MAX_REGISTRATIONS_PER_IP); return Number.isFinite(v) && v > 0 ? v : 2; })();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---- File fallback ----
function readStudentsFile() {
  ensureDataDir();
  if (!fs.existsSync(STUDENTS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeStudentsFile(students) {
  ensureDataDir();
  fs.writeFileSync(STUDENTS_FILE, JSON.stringify(students, null, 2), 'utf8');
}

// ---- Redis + file layer ----
let studentsCache = null;
let studentsCacheTime = 0;
const CACHE_TTL = 2000;

async function readStudents() {
  if (studentsCache && (Date.now() - studentsCacheTime < CACHE_TTL)) return studentsCache;
  const r = getRedis();
  if (r) {
    try {
      let data = await r.get(REDIS_KEY);
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      if (Array.isArray(data) && data.length > 0) {
        studentsCache = data;
        studentsCacheTime = Date.now();
        return studentsCache;
      }
    } catch (err) {
      console.error('Redis read students error:', err.message);
    }
  }
  const fb = readStudentsFile();
  studentsCache = fb;
  studentsCacheTime = Date.now();
  return fb;
}

async function writeStudents(students) {
  studentsCache = students;
  studentsCacheTime = Date.now();
  const r = getRedis();
  if (r) {
    try {
      await r.set(REDIS_KEY, students);
    } catch (err) {
      console.error('Redis write students error:', err.message);
    }
  }
  try { writeStudentsFile(students); } catch {}
}

function generateKey(name) {
  const slug = name.toLowerCase()
    .replace(/[čćž]/g, c => ({ 'č': 'c', 'ć': 'c', 'ž': 'z' }[c] || c))
    .replace(/[šđ]/g, c => ({ 'š': 's', 'đ': 'dj' }[c] || c))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const rand = crypto.randomBytes(4).toString('hex');
  return `va-${slug}-${rand}`;
}

export async function seedFromEnv() {
  const existing = await readStudents();
  if (existing.length > 0) return;

  const raw = process.env.STUDENT_API_KEYS || '';
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return;

  const seeded = keys.map((key, i) => ({
    name: `Student ${i + 1}`,
    key,
    created: new Date().toISOString(),
    active: true,
  }));
  await writeStudents(seeded);
  console.log(`Seeded ${seeded.length} students from STUDENT_API_KEYS env.`);
}

export async function getAllStudents() {
  return readStudents();
}

export async function getActiveKeys() {
  const students = await readStudents();
  return students.filter(s => s.active).map(s => s.key);
}

export async function findByKey(key) {
  const students = await readStudents();
  return students.find(s => s.key === key) || null;
}

export async function findByEmail(email) {
  if (!email) return null;
  const students = await readStudents();
  return students.find(s => s.email && s.email.toLowerCase() === email.toLowerCase()) || null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Anti-bot heuristics ────────────────────────────────────────────────────
//
// Bot farms grind through /auth/register with randomly-generated name parts
// ("wss wws", "li1tp 9mhe6", "uuanu nw6ny") and throwaway/disposable email
// addresses. These checks catch the two most common patterns seen in the
// 2026-04-20 wave without falsely blocking real users — real names contain
// at least one vowel and aren't all-digits. Error messages stay generic so
// bots can't trivially learn which heuristic fired.

// Popular disposable/throwaway domains. Not exhaustive (thousands exist) but
// covers the ones showing up in attack traffic. Extend via env
// DISPOSABLE_EMAIL_DOMAINS=foo.com,bar.net (merged with this list).
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'sharklasers.com', 'grr.la', '10minutemail.com', '10minutemail.net',
  'yopmail.com', 'yopmail.net', 'tempmail.com', 'tempmail.org', 'tempmail.plus',
  'temp-mail.org', 'temp-mail.io', 'tempr.email', 'tempail.com', 'tempemail.co',
  'dispostable.com', 'fakeinbox.com', 'mintemail.com', 'trashmail.com',
  'trashmail.net', 'throwawaymail.com', 'throwaway.email', 'maildrop.cc',
  'getnada.com', 'nada.email', 'getairmail.com', 'mohmal.com', 'emailondeck.com',
  'spam4.me', 'dropmail.me', 'mailnesia.com', 'mailcatch.com', 'emailtemporar.ro',
  'mytemp.email', 'emailfake.com', 'mvrht.net', 'burnermail.io', 'byom.de',
  'harakirimail.com', 'tmail.ws', 'tmails.net', 'disposable.email', 'etempmail.com',
  'inboxbear.com', 'mailhole.de', 'mailnull.com', 'spamgourmet.com', 'mailsac.com',
  'spambog.com', 'tempmail.email', 'tempmail.ninja', 'throwam.com', 'tempmailaddress.com',
  'wegwerfemail.de', 'armyspy.com', 'cuvox.de', 'dayrep.com', 'einrot.com',
  'fleckens.hu', 'gustr.com', 'jourrapide.com', 'rhyta.com', 'superrito.com',
  'teleworm.us', 'emailondeck.com', 'moakt.com', 'moakt.cc', 'mohmal.tech',
]);
const ENV_DISPOSABLE = (process.env.DISPOSABLE_EMAIL_DOMAINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
for (const d of ENV_DISPOSABLE) DISPOSABLE_EMAIL_DOMAINS.add(d);

const VOWEL_RE = /[aeiouAEIOUаеиоуАЕИОУ]/;

/**
 * Returns a short English reason code if the (name_part) looks like
 * random-generator output rather than a human name. null = looks human.
 * The checks are deliberately permissive in both directions — Serbian /
 * Balkan names like "Đorđe" or "Nađa" pass, while bot spew like "wss" or
 * "9mhe6" fails.
 */
function gibberishNameReason(part) {
  if (!part) return 'empty';
  const t = part.trim();
  // Real first/last names are almost always 3+ characters. Bot spew is full
  // of 2-char tokens like "wss", "xy", "ab". We bias toward blocking to
  // keep the attack surface tight; users with legitimate 2-char nicknames
  // can contact support.
  if (t.length < 3) return 'too_short';
  // Digits inside a human first/last name are a near-certain bot marker.
  if (/\d/.test(t)) return 'digits_in_name';
  // At least one "real" vowel (aeiou, or Cyrillic equivalents) — human
  // names virtually always have one. `y` is intentionally excluded here
  // because bot generators produce things like "wyb", "nxy" that would
  // slip through otherwise.
  if (!/[aeiouAEIOUаеиоуАЕИОУ]/.test(t)) return 'no_vowel';
  // Low-entropy 3-char tokens ("aaa", "xyz" repeated chars).
  if (t.length <= 3) {
    const uniq = new Set(t.toLowerCase()).size;
    if (uniq <= 1) return 'repeat_char';
  }
  // >4 consecutive consonants (no vowel break) looks like random junk.
  if (/[bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]{5,}/.test(t)) return 'consonant_run';
  return null;
}

function emailDomainOf(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).toLowerCase();
}

export async function addStudent(name, email) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return { error: 'Ime mora imati najmanje 2 karaktera.' };
  }
  if (name.length > 100) {
    return { error: 'Ime ne može biti duže od 100 karaktera.' };
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return { error: 'Unesite ispravnu email adresu.' };
  }
  if (email.length > 100) {
    return { error: 'Email ne može biti duži od 100 karaktera.' };
  }

  const cleanEmail = email.trim().toLowerCase().replace(/[<>"'&;]/g, '');
  const students = await readStudents();
  const trimmed = name.trim().replace(/[<>"'&;]/g, '');

  // Disposable / throwaway email → reject. Generic message on purpose so
  // bots can't A/B test which domains are flagged.
  const domain = emailDomainOf(cleanEmail);
  if (domain && DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    console.warn(`[AntiBot] Rejected disposable domain: ${domain}`);
    return { error: 'Molimo koristi primarnu email adresu (nije dozvoljen privremeni email servis).' };
  }

  // Gibberish name heuristic — check each whitespace-separated part. Real
  // "Firstname Lastname" inputs pass; "wss wws" / "li1tp 9mhe6" fail.
  const parts = trimmed.split(/\s+/).filter(Boolean);
  for (const p of parts) {
    const reason = gibberishNameReason(p);
    if (reason) {
      console.warn(`[AntiBot] Rejected gibberish name part "${p}" (reason=${reason}) <${cleanEmail}>`);
      return { error: 'Ime ne izgleda ispravno. Unesi svoje pravo ime i prezime.' };
    }
  }

  if (students.length >= MAX_STUDENTS) {
    return { error: `Maksimalan broj korisnika dostignut (${MAX_STUDENTS}).` };
  }
  if (students.some(s => s.email && s.email.toLowerCase() === cleanEmail)) {
    return { error: 'Nalog sa ovim emailom već postoji.' };
  }

  const key = generateKey(trimmed);
  const student = {
    name: trimmed,
    email: cleanEmail,
    key,
    created: new Date().toISOString(),
    active: true,
  };
  students.push(student);
  await writeStudents(students);
  return { student };
}

export async function removeStudent(key) {
  const students = await readStudents();
  const idx = students.findIndex(s => s.key === key);
  if (idx === -1) return { error: 'Student sa tim ključem ne postoji.' };
  const removed = students.splice(idx, 1)[0];
  await writeStudents(students);
  return { removed };
}

/**
 * Atomically delete many students in a single read-modify-write cycle.
 * Prevents the race condition you hit when looping removeStudent() — each
 * parallel call would re-read the file, potentially from before earlier
 * writes landed, and lose deletions along the way.
 *
 * Returns { removed: Student[], notFound: string[] } so the caller can
 * report precisely how many actually went away vs. how many were already
 * gone (e.g. deleted in another tab).
 */
export async function removeStudents(keys) {
  const keySet = new Set((keys || []).filter(Boolean));
  if (keySet.size === 0) return { removed: [], notFound: [] };
  const students = await readStudents();
  const removed = [];
  const kept = [];
  for (const s of students) {
    if (keySet.has(s.key)) { removed.push(s); keySet.delete(s.key); }
    else kept.push(s);
  }
  if (removed.length > 0) await writeStudents(kept);
  return { removed, notFound: [...keySet] };
}

export async function toggleStudent(key, active) {
  const students = await readStudents();
  const student = students.find(s => s.key === key);
  if (!student) return { error: 'Student sa tim ključem ne postoji.' };
  student.active = active;
  await writeStudents(students);
  return { student };
}

export async function toggleStudentMarkup(key, noMarkup) {
  const students = await readStudents();
  const student = students.find(s => s.key === key);
  if (!student) return { error: 'Student sa tim ključem ne postoji.' };
  student.noMarkup = noMarkup;
  await writeStudents(students);
  return { student };
}

// ---- IP registration tracking (persistent) ----
let regCache = null;
let regCacheTime = 0;

function readRegistrationsFile() {
  ensureDataDir();
  if (!fs.existsSync(REGISTRATIONS_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRATIONS_FILE, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch { return {}; }
}

function writeRegistrationsFile(regs) {
  ensureDataDir();
  fs.writeFileSync(REGISTRATIONS_FILE, JSON.stringify(regs, null, 2), 'utf8');
}

async function readRegistrations() {
  if (regCache && (Date.now() - regCacheTime < CACHE_TTL)) return regCache;
  const r = getRedis();
  if (r) {
    try {
      let data = await r.get(REDIS_REG_KEY);
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        regCache = data;
        regCacheTime = Date.now();
        return regCache;
      }
    } catch (err) {
      console.error('Redis read registrations error:', err.message);
    }
  }
  const fb = readRegistrationsFile();
  regCache = fb;
  regCacheTime = Date.now();
  return fb;
}

async function writeRegistrations(regs) {
  regCache = { ...regs };
  regCacheTime = Date.now();
  const r = getRedis();
  if (r) {
    try { await r.set(REDIS_REG_KEY, regs); }
    catch (err) { console.error('Redis write registrations error:', err.message); }
  }
  try { writeRegistrationsFile(regs); } catch {}
}

import { normalizeIP, WHITELIST_IPS } from './utils.js';

export async function canRegisterFromIP(ip) {
  if (!ip) return false;
  if (WHITELIST_IPS.has(normalizeIP(ip))) return true;
  const regs = await readRegistrations();
  const count = regs[normalizeIP(ip)] || 0;
  return count < MAX_REG_PER_IP;
}

export async function trackRegistrationIP(ip) {
  if (!ip) return;
  regCache = null;
  const regs = await readRegistrations();
  const normalized = normalizeIP(ip);
  regs[normalized] = (regs[normalized] || 0) + 1;
  await writeRegistrations(regs);
}

export async function getRegistrationCount(ip) {
  if (!ip) return 0;
  const regs = await readRegistrations();
  return regs[normalizeIP(ip)] || 0;
}

// ─── Password hashing (scrypt, zero dependencies) ───────────────────────────

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptHash(password, salt);
  return `${salt}:${hash}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const derived = await scryptHash(password, salt);
  const derivedBuffer = Buffer.from(derived, 'hex');
  return timingSafeEqual(hashBuffer, derivedBuffer);
}

export async function setStudentPassword(key, password) {
  if (!password || password.length < 8) {
    return { error: 'Lozinka mora imati najmanje 8 karaktera.' };
  }
  if (password.length > 200) {
    return { error: 'Lozinka je predugačka.' };
  }
  const students = await readStudents();
  const student = students.find(s => s.key === key);
  if (!student) return { error: 'Student ne postoji.' };
  student.password_hash = await hashPassword(password);
  await writeStudents(students);
  return { ok: true };
}

export async function authenticateWithPassword(email, password) {
  if (!email || !password) return null;
  const student = await findByEmail(email);
  if (!student || !student.active) return null;
  if (!student.password_hash) return null;
  const valid = await verifyPassword(password, student.password_hash);
  return valid ? student : null;
}

export async function addStudentWithPassword(name, email, password, { requireEmailVerification = false } = {}) {
  if (!password || typeof password !== 'string' || password.length < 6) {
    return { error: 'Lozinka mora imati najmanje 6 karaktera.' };
  }
  const result = await addStudent(name, email);
  if (result.error) return result;
  result.student.password_hash = await hashPassword(password);
  if (requireEmailVerification) {
    result.student.email_verified = false;
  }
  const students = await readStudents();
  const idx = students.findIndex(s => s.key === result.student.key);
  if (idx !== -1) {
    students[idx] = result.student;
    await writeStudents(students);
  }
  return result;
}

export async function studentHasPassword(email) {
  if (!email) return false;
  const student = await findByEmail(email);
  return !!(student && student.password_hash);
}

// ─── Email verification ─────────────────────────────────────────────────────
//
// Anti-bot defense for the self-signup flow. New accounts start with
// email_verified=false and a random 32-byte token. The welcome bonus
// ($2 credit) is NOT granted until the user clicks the link we email
// them. Accounts created before this feature existed have email_verified
// undefined and are treated as grandfathered-verified.

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function isStudentEmailVerified(student) {
  if (!student) return false;
  // Legacy accounts (no flag set) are grandfathered as verified.
  return student.email_verified !== false;
}

export async function createEmailVerificationToken(key) {
  const students = await readStudents();
  const student = students.find(s => s.key === key);
  if (!student) return null;
  const token = crypto.randomBytes(32).toString('hex');
  student.email_verification_token = token;
  student.email_verification_expires_at = Date.now() + VERIFICATION_TOKEN_TTL_MS;
  await writeStudents(students);
  return token;
}

export async function findByVerificationToken(token) {
  if (!token || typeof token !== 'string') return null;
  const students = await readStudents();
  return students.find(s =>
    s.email_verification_token === token &&
    (s.email_verification_expires_at || 0) > Date.now()
  ) || null;
}

export async function markEmailVerified(key) {
  const students = await readStudents();
  const student = students.find(s => s.key === key);
  if (!student) return null;
  student.email_verified = true;
  student.email_verified_at = new Date().toISOString();
  delete student.email_verification_token;
  delete student.email_verification_expires_at;
  await writeStudents(students);
  return student;
}

/**
 * Atomically sets welcome_bonus_granted=true if not already set.
 * Returns true only the first time (so caller knows to credit $2);
 * subsequent calls return false and never re-grant.
 */
export async function claimWelcomeBonus(key) {
  const students = await readStudents();
  const student = students.find(s => s.key === key);
  if (!student) return false;
  if (student.welcome_bonus_granted === true) return false;
  student.welcome_bonus_granted = true;
  student.welcome_bonus_granted_at = new Date().toISOString();
  await writeStudents(students);
  return true;
}

/**
 * Bulk-delete unverified accounts that are older than `minAgeMinutes`
 * and younger than `maxAgeHours`. Used to clean up bot signups.
 * Returns the list of removed students so the caller can log them.
 */
export async function purgeUnverifiedStudents({ minAgeMinutes = 0, maxAgeHours = 72 } = {}) {
  const students = await readStudents();
  const now = Date.now();
  const minAgeMs = minAgeMinutes * 60 * 1000;
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  const keep = [];
  const removed = [];
  for (const s of students) {
    if (s.email_verified === false) {
      const createdMs = s.created ? new Date(s.created).getTime() : 0;
      const ageMs = now - createdMs;
      if (ageMs >= minAgeMs && ageMs <= maxAgeMs) {
        removed.push(s);
        continue;
      }
    }
    keep.push(s);
  }

  if (removed.length > 0) {
    await writeStudents(keep);
  }
  return removed;
}
