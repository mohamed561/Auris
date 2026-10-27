import { createClient } from 'redis';
import crypto from 'node:crypto';

const HASH = 'auris:progress';
const META = 'auris:meta';
const cover = (u) => (/^https:\/\/(covers\.openlibrary\.org|([a-z0-9-]+\.)*hardcover\.app|books\.google\.com|books\.googleusercontent\.com)\//.test(u) ? String(u).slice(0, 400) : '');
let client;
async function db() {
  if (!client) {
    const c = createClient({ url: process.env.REDIS_URL });
    c.on('error', () => {});
    await c.connect();
    client = c;
  }
  return client;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
// Accepts SYNC_KEY and any variable ending in _SYNC_KEY (for example VALAR_SYNC_KEY, TITUS_SYNC_KEY).
const keys = () => Object.entries(process.env).filter(([k, v]) => v && (k === 'SYNC_KEY' || k.endsWith('_SYNC_KEY'))).map(([, v]) => v);
const authorized = (given) => !!given && keys().some((k) => crypto.timingSafeEqual(sha(given), sha(k)));

export default async function handler(req, res) {
  if (!authorized(req.headers['x-sync-key'])) return res.status(401).json({ error: 'unauthorized' });
  try {
    const r = await db();
    if (req.method === 'GET') {
      const raw = await r.hGetAll(HASH);
      const mraw = await r.hGetAll(META);
      const parse = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.parse(v)]));
      return res.status(200).json({ items: parse(raw), meta: parse(mraw) });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      if (b.kind === 'meta') {
        if (!/^[a-f0-9]{64}$/.test(b.id) || !Number.isFinite(b.metaAt)) return res.status(400).json({ error: 'bad body' });
        const o = await r.hGet(META, b.id);
        if (o && JSON.parse(o).metaAt >= b.metaAt) return res.status(200).json({ stale: true });
        await r.hSet(META, b.id, JSON.stringify({ title: String(b.title || '').slice(0, 200), author: String(b.author || '').slice(0, 200), coverUrl: cover(b.coverUrl), metaAt: b.metaAt }));
        return res.status(200).json({ ok: true });
      }
      const ok = /^[a-f0-9]{64}$/.test(b.id) && Number.isFinite(b.position) && b.position >= 0 && Number.isFinite(b.updatedAt);
      if (!ok) return res.status(400).json({ error: 'bad body' });
      const oldRaw = await r.hGet(HASH, b.id);
      const old = oldRaw ? JSON.parse(oldRaw) : null;
      if (old && old.updatedAt >= b.updatedAt) return res.status(200).json({ stale: true, item: old });
      const item = {
        id: b.id, part: Number.isInteger(b.part) && b.part >= 0 ? b.part : 0, device: String(b.device || '').slice(0, 60),
        position: b.position, duration: Number(b.duration) || 0, updatedAt: b.updatedAt, finished: !!b.finished,
        title: String(b.title || '').slice(0, 200), author: String(b.author || '').slice(0, 200),
      };
      await r.hSet(HASH, b.id, JSON.stringify(item));
      return res.status(200).json({ item });
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
}
