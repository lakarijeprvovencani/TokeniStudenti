import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getRedis, isRedisConfigured } from './redis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
const REDIS_KEY = 'vajb:students';

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

function parseArr(data) {
  if (Array.isArray(data)) return data;
  if (typeof data === 'string') { try { const p = JSON.parse(data); return Array.isArray(p) ? p : null; } catch { return null; } }
  return null;
}

async function readStudents() {
  if (studentsCache && (Date.now() - studentsCacheTime < CACHE_TTL)) return studentsCache;
  const r = getRedis();
  if (r) {
    try {
      const data = await r.get(REDIS_KEY);
      const parsed = parseArr(data);
      if (parsed && parsed.length > 0) {
        studentsCache = parsed;
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
      await r.set(REDIS_KEY, JSON.stringify(students));
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

export async function addStudent(name) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return { error: 'Ime mora imati najmanje 2 karaktera.' };
  }
  if (name.length > 100) {
    return { error: 'Ime ne može biti duže od 100 karaktera.' };
  }
  const students = await readStudents();
  const trimmed = name.trim().replace(/[<>"'&;]/g, '');

  if (students.length >= 500) {
    return { error: 'Maksimalan broj studenata dostignut (500).' };
  }
  if (students.some(s => s.name.toLowerCase() === trimmed.toLowerCase())) {
    return { error: `Student "${trimmed}" već postoji.` };
  }

  const key = generateKey(trimmed);
  const student = {
    name: trimmed,
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
