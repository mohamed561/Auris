import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const HASH = 'auris:progress';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export default async function handler(req, res) {
  const given = req.headers['x-sync-key'] || '';
  const expected = process.env.SYNC_KEY || '';
  if (!expected || !given || !crypto.timingSafeEqual(sha(given), sha(expected))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method === 'GET') {
    return res.status(200).json({ items: (await redis.hgetall(HASH)) || {} });
  }
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const ok = /^[a-f0-9]{64}$/.test(b.id) && Number.isFinite(b.position) && b.position >= 0 && Number.isFinite(b.updatedAt);
    if (!ok) return res.status(400).json({ error: 'bad body' });
    const old = await redis.hget(HASH, b.id);
    if (old && old.updatedAt >= b.updatedAt) return res.status(200).json({ stale: true, item: old });
    const item = {
      id: b.id, part: Number.isInteger(b.part) && b.part >= 0 ? b.part : 0, device: String(b.device || '').slice(0, 60), position: b.position, duration: Number(b.duration) || 0, updatedAt: b.updatedAt,
      finished: !!b.finished, title: String(b.title || '').slice(0, 200), author: String(b.author || '').slice(0, 200),
    };
    await redis.hset(HASH, { [b.id]: item });
    return res.status(200).json({ item });
  }
  return res.status(405).json({ error: 'method not allowed' });
}
