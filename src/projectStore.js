/**
 * Server-side project persistence — Upstash Redis.
 *
 * Keys:
 *   vajb:projects:{ownerKeyId}             → JSON array of project summaries
 *   vajb:project:{ownerKeyId}:{projectId}  → full project JSON
 *
 * Every function takes ownerKeyId as first arg for row-level isolation.
 */

import { getRedis } from './redis.js';
import { deletePrefix as r2DeletePrefix } from './r2.js';

const SUMMARIES_PREFIX = 'vajb:projects:';
const PROJECT_PREFIX = 'vajb:project:';
const MAX_PROJECTS_PER_USER = 50;

function summariesKey(ownerKeyId) { return `${SUMMARIES_PREFIX}${ownerKeyId}`; }
function projectKey(ownerKeyId, projectId) { return `${PROJECT_PREFIX}${ownerKeyId}:${projectId}`; }

function toSummary(p) {
  return {
    id: p.id,
    name: p.name || '',
    model: p.model || '',
    prompt: (p.prompt || '').slice(0, 120),
    createdAt: p.createdAt || Date.now(),
    updatedAt: p.updatedAt || Date.now(),
    fileCount: p.files ? Object.keys(p.files).filter(f => !f.endsWith('/')).length : 0,
  };
}

export async function listProjects(ownerKeyId) {
  const redis = getRedis();
  if (!redis) return [];
  const raw = await redis.get(summariesKey(ownerKeyId));
  if (!raw) return [];
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(arr) ? arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
}

export async function loadProject(ownerKeyId, projectId) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(projectKey(ownerKeyId, projectId));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function saveProject(ownerKeyId, project) {
  const redis = getRedis();
  if (!redis) throw new Error('Redis not configured');
  if (!project || !project.id) throw new Error('Project must have an id');

  project.updatedAt = Date.now();
  if (!project.createdAt) project.createdAt = Date.now();

  await redis.set(projectKey(ownerKeyId, project.id), JSON.stringify(project));

  const summaries = await listProjects(ownerKeyId);
  const idx = summaries.findIndex(s => s.id === project.id);
  const summary = toSummary(project);
  if (idx >= 0) {
    summaries[idx] = summary;
  } else {
    summaries.unshift(summary);
    if (summaries.length > MAX_PROJECTS_PER_USER) summaries.length = MAX_PROJECTS_PER_USER;
  }
  await redis.set(summariesKey(ownerKeyId), JSON.stringify(summaries));

  return summary;
}

export async function deleteProject(ownerKeyId, projectId) {
  const redis = getRedis();
  if (!redis) return;

  await redis.del(projectKey(ownerKeyId, projectId));

  const summaries = await listProjects(ownerKeyId);
  const filtered = summaries.filter(s => s.id !== projectId);
  await redis.set(summariesKey(ownerKeyId), JSON.stringify(filtered));

  try {
    await r2DeletePrefix(`${ownerKeyId}/${projectId}/`);
  } catch (err) {
    console.warn('[projectStore] R2 cleanup failed for', projectId, err.message);
  }
}
