import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const keys = () => Object.entries(process.env).filter(([k, v]) => v && (k === 'SYNC_KEY' || k.endsWith('_SYNC_KEY'))).map(([, v]) => v);
const authorized = (g) => !!g && keys().some((k) => crypto.timingSafeEqual(sha(g), sha(k)));

// Book search on the server so the Hardcover token never reaches the browser.
async function hardcover(q) {
  const t = process.env.HARDCOVER_TOKEN;
  if (!t) return [];
  const r = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: t.startsWith('Bearer ') ? t : `Bearer ${t}` },
    body: JSON.stringify({ query: 'query($q:String!){search(query:$q,query_type:"Book",per_page:6,page:1){results}}', variables: { q } }),
  });
  const hits = (await r.json())?.data?.search?.results?.hits || [];
  return hits.map((h) => h.document).filter(Boolean).map((d) => ({ title: d.title, author: (d.author_names || [])[0] || '', coverUrl: d.image?.url || '' }));
}
async function google(q) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?maxResults=6&printType=books&q=${encodeURIComponent(q)}`);
  return ((await r.json()).items || []).map((i) => {
    const v = i.volumeInfo || {}, l = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '';
    return { title: v.title, author: (v.authors || [])[0] || '', coverUrl: l.replace('http://', 'https://').replace('&edge=curl', '').replace(/zoom=\d/, 'zoom=0') };
  });
}
async function openlibrary(q) {
  const r = await fetch(`https://openlibrary.org/search.json?limit=6&fields=title,author_name,cover_i&q=${encodeURIComponent(q)}`);
  return ((await r.json()).docs || []).map((d) => ({ title: d.title, author: (d.author_name || [])[0] || '', coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '' }));
}

export default async function handler(req, res) {
  if (!authorized(req.headers['x-sync-key'])) return res.status(401).json({ error: 'unauthorized' });
  const q = String(req.query.q || '').slice(0, 200).trim();
  if (!q) return res.status(400).json({ error: 'missing q' });
  const lists = await Promise.all([hardcover, google, openlibrary].map((f) => f(q).catch(() => [])));
  const seen = new Set();
  const results = lists.flat().filter((x) => x.title && !seen.has((x.title + x.author).toLowerCase()) && seen.add((x.title + x.author).toLowerCase())).slice(0, 10);
  return res.status(200).json({ results });
}
