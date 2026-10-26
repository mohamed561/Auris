import { createStore, get, set, del, values } from 'idb-keyval';
import { parseBlob } from 'music-metadata';

const bookStore = createStore('auris-books', 'books');
const handleStore = createStore('auris-handles', 'handles');
export const getAll = () => values(bookStore);
export const getBook = (id) => get(id, bookStore);
export const putBook = (b) => set(b.id, b, bookStore);
export const getHandle = (k) => get(k, handleStore);
export const putHandle = (k, h) => set(k, h, handleStore);

export const device = () => localStorage.getItem('deviceName') || '';
export const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
export const mime = (f) => {
  const e = f.name.split('.').pop().toLowerCase();
  return { m4b: 'audio/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' }[e] || f.type || 'audio/mpeg';
};
export const cleanName = (n) => n.replace(/\.[^.]+$/, '').replace(/[_.]+/g, ' ').replace(/[\s-]*(part|pt|cd|disc|disk)?[\s-]*\d+$/i, '').trim() || n;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const hashText = async (t) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
// Same file on any device gives the same fingerprint: first 256 KB + last 256 KB + size.
export async function fingerprint(file) {
  const n = 262144;
  const parts = await Promise.all([file.slice(0, n), file.slice(Math.max(0, file.size - n))].map((p) => p.arrayBuffer()));
  return hex(await crypto.subtle.digest('SHA-256', await new Blob([...parts, new TextEncoder().encode(String(file.size))]).arrayBuffer()));
}

export async function readMeta(file) {
  try {
    const c = (await parseBlob(file)).common;
    const pic = c.picture?.[0];
    return { title: c.album || c.title || '', author: c.artist || c.albumartist || '', cover: pic ? new Blob([pic.data], { type: pic.format }) : null };
  } catch { return { title: '', author: '', cover: null }; }
}
export async function searchBooks(q) {
  const r = await fetch(`https://openlibrary.org/search.json?limit=6&fields=title,author_name,cover_i&q=${encodeURIComponent(q)}`);
  const j = await r.json();
  return (j.docs || []).map((d) => ({ title: d.title, author: (d.author_name || [])[0] || '', coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '' }));
}

// Files are never uploaded. Desktop Chrome/Edge can remember them; phones re-pick them.
export async function pickFiles() {
  if ('showOpenFilePicker' in window) {
    const hs = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'Audiobooks', accept: { 'audio/*': ['.mp3', '.m4b', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wav'] } }] });
    return Promise.all(hs.map(async (handle) => ({ file: await handle.getFile(), handle })));
  }
  return new Promise((res, rej) => {
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true; i.accept = 'audio/*,.m4b';
    i.onchange = () => (i.files.length ? res([...i.files].map((file) => ({ file }))) : rej(new Error('none')));
    i.click();
  });
}
export async function openHandle(h) {
  try {
    let p = await h.queryPermission({ mode: 'read' });
    if (p !== 'granted') p = await h.requestPermission({ mode: 'read' });
    return p === 'granted' ? await h.getFile() : null;
  } catch { return null; }
}

const key = () => localStorage.getItem('syncKey') || '';
const hdr = () => ({ 'content-type': 'application/json', 'x-sync-key': key() });
export const toItem = (b) => ({ id: b.id, part: b.part || 0, position: b.position || 0, duration: b.duration || 0, updatedAt: b.updatedAt || 0, finished: !!b.finished, title: b.title, author: b.author, device: device() });
export async function pull() {
  if (!key()) return {};
  const r = await fetch('/api/progress', { headers: hdr() });
  if (!r.ok) throw new Error('pull ' + r.status);
  return (await r.json()).items || {};
}
export async function push(item, keepalive = false) {
  if (!key()) throw new Error('no sync key');
  const r = await fetch('/api/progress', { method: 'POST', headers: hdr(), body: JSON.stringify(item), keepalive });
  if (!r.ok) throw new Error('push ' + r.status);
}

export async function pullAll() {
  if (!key()) return { items: {}, meta: {} };
  const r = await fetch('/api/progress', { headers: hdr() });
  if (!r.ok) throw new Error('pull ' + r.status);
  const j = await r.json();
  return { items: j.items || {}, meta: j.meta || {} };
}
export async function pushMeta(b) {
  if (!key()) return;
  await fetch('/api/progress', { method: 'POST', headers: hdr(), body: JSON.stringify({ kind: 'meta', id: b.id, title: b.title, author: b.author || '', coverUrl: b.coverUrl || '', metaAt: b.metaAt }) });
}

// Phones cannot remember a picked file, so on phones the file is copied once into the app's private storage.
export const wantCopy = () => !!navigator.storage?.getDirectory && (!('showOpenFilePicker' in window) || /Android|iPhone|iPad/i.test(navigator.userAgent));
export async function copyLocal(file, name, onProgress) {
  const dir = await navigator.storage.getDirectory();
  const fh = await dir.getFileHandle(name, { create: true });
  if (!fh.createWritable) throw new Error('unsupported');
  let n = 0;
  const count = new TransformStream({ transform(c, ctl) { n += c.byteLength; onProgress?.(n / file.size); ctl.enqueue(c); } });
  try { await file.stream().pipeThrough(count).pipeTo(await fh.createWritable()); }
  catch (e) { await removeLocal(name); throw e; }
}
export async function readLocal(name) {
  try { return await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile(); } catch { return null; }
}
export async function removeLocal(name) {
  try { await (await navigator.storage.getDirectory()).removeEntry(name); } catch {}
}
export async function removeBook(b) {
  await del(b.id, bookStore);
  for (let i = 0; i < b.parts.length; i++) { await removeLocal(`${b.id}_${i}`); await del(`${b.id}:${i}`, handleStore); }
}
