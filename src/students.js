import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStudents() {
  ensureDataDir();
  if (!fs.existsSync(STUDENTS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeStudents(students) {
  ensureDataDir();
  fs.writeFileSync(STUDENTS_FILE, JSON.stringify(students, null, 2), 'utf8');
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

/**
 * Seed students from STUDENT_API_KEYS env var (backward compatibility).
 * Only runs if students.json is empty/missing.
 */
export function seedFromEnv() {
  const existing = readStudents();
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
  writeStudents(seeded);
  console.log(`Seeded ${seeded.length} students from STUDENT_API_KEYS env.`);
}

export function getAllStudents() {
  return readStudents();
}

export function getActiveKeys() {
  return readStudents().filter(s => s.active).map(s => s.key);
}

export function findByKey(key) {
  return readStudents().find(s => s.key === key) || null;
}

export function addStudent(name) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return { error: 'Ime mora imati najmanje 2 karaktera.' };
  }
  const students = readStudents();
  const trimmed = name.trim();

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
  writeStudents(students);
  return { student };
}

export function removeStudent(key) {
  const students = readStudents();
  const idx = students.findIndex(s => s.key === key);
  if (idx === -1) return { error: 'Student sa tim ključem ne postoji.' };
  const removed = students.splice(idx, 1)[0];
  writeStudents(students);
  return { removed };
}

export function toggleStudent(key, active) {
  const students = readStudents();
  const student = students.find(s => s.key === key);
  if (!student) return { error: 'Student sa tim ključem ne postoji.' };
  student.active = active;
  writeStudents(students);
  return { student };
}
