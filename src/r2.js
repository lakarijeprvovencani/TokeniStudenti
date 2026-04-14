/**
 * Cloudflare R2 (S3-compatible) wrapper.
 * Stores binary project assets (images, video, fonts).
 * Key format: {ownerKeyId}/{projectId}/{filename}
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.R2_BUCKET || 'vajbagent';
const ENDPOINT = process.env.R2_ENDPOINT || `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || '';

let client = null;

function getClient() {
  if (client) return client;
  if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) return null;
  client = new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });
  return client;
}

export function isR2Configured() {
  return !!(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY);
}

export async function putObject(key, buffer, contentType) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
}

export async function headObject(key) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  try {
    const resp = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { size: resp.ContentLength, contentType: resp.ContentType };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function deleteObject(key) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function deletePrefix(prefix) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  let continuationToken;
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (list.Contents || []).map(o => ({ Key: o.Key }));
    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: objects },
      }));
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

export async function getSignedUploadUrl(key, contentType, expiresSec = 300) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 not configured');
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, command, { expiresIn: expiresSec });
}

export function publicUrl(key) {
  if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL}/${key}`;
  return `${ENDPOINT}/${BUCKET}/${key}`;
}
