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

export async function addStudentWithPassword(name, email, password) {
  if (!password || typeof password !== 'string' || password.length < 6) {
    return { error: 'Lozinka mora imati najmanje 6 karaktera.' };
  }
  const result = await addStudent(name, email);
  if (result.error) return result;
  // Set password on the newly created student
  result.student.password_hash = await hashPassword(password);
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
