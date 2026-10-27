import { useEffect, useMemo, useRef, useState } from 'react';
import { getAll, getBook, putBook, getHandle, putHandle, device, fmt, mime, cleanName, hashText, fingerprint, readMeta, searchBooks, pickFiles, openHandle, copyLocal, readLocal, wantCopy, removeBook, pull, pullAll, pushMeta, push, toItem } from './lib.js';

const useCover = (b) => {
  const u = useMemo(() => (b.cover ? URL.createObjectURL(b.cover) : ''), [b.cover]);
  return b.coverUrl || u;
};
const cancelled = (e) => e?.name === 'AbortError' || e?.message === 'none';

export default function App() {
  const [books, setBooks] = useState([]);
  const [cur, setCur] = useState(null);
  const [edit, setEdit] = useState(null);
  const [setup, setSetup] = useState(!device());
  const [order, setOrder] = useState(null);
  const [msg, setMsg] = useState('');
  const [naming, setNaming] = useState(null);
  const [inst, setInst] = useState(null);
  useEffect(() => { const h = (e) => { e.preventDefault(); setInst(e); }; addEventListener('beforeinstallprompt', h); return () => removeEventListener('beforeinstallprompt', h); }, []);

  const refresh = async () => setBooks((await getAll()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.addedAt - a.addedAt));
  const flush = async () => {
    for (const b of await getAll()) if (b.dirty) push(toItem(b)).then(async () => putBook({ ...(await getBook(b.id)), dirty: false })).catch(() => {});
  };
  // Titles, authors and covers follow the book to every device; the newest edit wins.
  const syncMeta = async () => {
    try {
      const { meta, items } = await pullAll();
      let changed = false;
      for (const b of await getAll()) {
        const m = meta[b.id], t = b.metaAt || b.addedAt || 0;
        if (m && m.metaAt > t) { await putBook({ ...b, title: m.title, author: m.author, coverUrl: m.coverUrl, metaAt: m.metaAt }); changed = true; }
        else if (t > (m?.metaAt || 0)) pushMeta({ ...b, metaAt: t }).catch(() => {});
      }
      for (const b of await getAll()) {
        const r = items[b.id];
        if (r && r.device !== device() && r.updatedAt > (b.updatedAt || 0)) { await putBook({ ...b, part: r.part || 0, position: r.position, finished: r.finished, updatedAt: r.updatedAt }); changed = true; }
      }
      if (changed) refresh();
    } catch {}
  };
  useEffect(() => {
    refresh(); flush(); syncMeta();
    const vis = () => document.visibilityState === 'visible' && syncMeta();
    addEventListener('online', flush); document.addEventListener('visibilitychange', vis);
    return () => { removeEventListener('online', flush); document.removeEventListener('visibilitychange', vis); };
  }, []);

  async function saveProgress(id, p, keepalive) {
    const cur0 = await getBook(id);
    if (!cur0) return;
    const nb = { ...cur0, ...p, updatedAt: Date.now(), dirty: true };
    await putBook(nb);
    try { await push(toItem(nb), keepalive); await putBook({ ...nb, dirty: false }); } catch {}
  }
  // Opening a book last played on another device jumps there automatically (the player starts 10 seconds earlier).
  async function start(b, files) {
    const remote = (await pull().catch(() => ({})))[b.id];
    if (remote && remote.device !== device() && remote.updatedAt > (b.updatedAt || 0)) {
      b = { ...b, part: remote.part || 0, position: remote.position, finished: remote.finished, updatedAt: remote.updatedAt };
      await putBook(b);
    }
    setCur({ book: b, files });
  }
  async function resolve(b, items) {
    const fps = await Promise.all(items.map((i) => fingerprint(i.file)));
    const files = [];
    for (let i = 0; i < b.parts.length; i++) {
      const j = fps.indexOf(b.parts[i].fp);
      if (j < 0) return null;
      files.push(items[j].file);
      if (items[j].handle) await putHandle(`${b.id}:${i}`, items[j].handle);
    }
    return files;
  }
  async function keepCopies(b, files) {
    if (!wantCopy()) return;
    try {
      navigator.storage.persist?.();
      for (let i = 0; i < files.length; i++) {
        const k = `${b.id}_${i}`;
        if (await readLocal(k)) continue;
        await copyLocal(files[i], k, (p) => setMsg(`Saving a copy on this device, part ${i + 1} of ${files.length}: ${Math.round(p * 100)}%`));
      }
      setMsg('');
    } catch { setMsg('Could not save a copy on this device. You may need to pick the file again next time.'); }
  }
  async function open(b) {
    try {
      let files = [];
      for (let i = 0; i < b.parts.length; i++) {
        let f = await readLocal(`${b.id}_${i}`);
        if (!f) { const h = await getHandle(`${b.id}:${i}`); f = h ? await openHandle(h) : null; }
        if (!f) { files = null; break; }
        files.push(f);
      }
      if (!files) {
        files = await resolve(b, await pickFiles());
        if (!files) return setMsg(`Select all ${b.parts.length} file(s) of "${b.title}".`);
        await keepCopies(b, files);
      }
      await start(b, files);
    } catch (e) { if (!cancelled(e)) setMsg('Could not open the file.'); }
  }
  async function add() {
    try {
      const items = (await pickFiles()).sort((x, y) => x.file.name.localeCompare(y.file.name, undefined, { numeric: true }));
      if (items.length > 1) setOrder(items); else await finishAdd(items);
    } catch (e) { if (!cancelled(e)) setMsg('Could not read that file.'); }
  }
  async function createBook(items, fps, id, m, title) {
    const rm = (await pullAll().catch(() => ({ meta: {} }))).meta[id];
    let author = rm?.author ?? m.author, coverUrl = rm?.coverUrl || '';
    if (!rm) {
      try { const [h] = await searchBooks(`${title} ${m.author || ''}`.trim()); if (h) { author = author || h.author; coverUrl = h.coverUrl; } } catch {}
    }
    const b = { id, title: rm?.title || title, author, cover: m.cover, coverUrl, metaAt: rm?.metaAt || Date.now(), parts: items.map((it, i) => ({ name: it.file.name, fp: fps[i] })), part: 0, position: 0, updatedAt: 0, addedAt: Date.now() };
    await putBook(b);
    if (!rm) pushMeta(b).catch(() => {});
    return b;
  }
  async function begin(b, items) {
    const files = await resolve(b, items);
    await keepCopies(b, files);
    await refresh();
    await start(b, files);
  }
  async function finishAdd(items) {
    setOrder(null);
    try {
      const fps = await Promise.all(items.map((i) => fingerprint(i.file)));
      const id = await hashText(fps.join('|'));
      let b = await getBook(id);
      if (!b) {
        const m = await readMeta(items[0].file);
        const rm = (await pullAll().catch(() => ({ meta: {} }))).meta[id];
        if (!rm && !m.title) return setNaming({ items, fps, id, m, guess: cleanName(items[0].file.name) });
        b = await createBook(items, fps, id, m, m.title);
      }
      await begin(b, items);
    } catch { setMsg('Could not add that audiobook.'); }
  }

  return (
    <div className="app">
      {cur ? (
        <Player key={cur.book.id} {...cur} onSave={(p, k) => saveProgress(cur.book.id, p, k)} onEdit={() => setEdit(cur.book)} onBack={() => { setCur(null); refresh(); }} />
      ) : (
        <main className="lib">
          <header><h1><img className="logo" src="/icon-192.png" alt="AURIS" /></h1><div>{inst && <button className="ghost" onClick={() => { inst.prompt(); setInst(null); }}>Install</button>}<button className="ghost" onClick={() => setSetup(true)}>{device() || 'Device'}</button><button className="primary" onClick={add}>Add audiobook</button></div></header>
          {msg && <p className="note" onClick={() => setMsg('')}>{msg}</p>}
          {!books.length && <p className="empty">Your shelf is empty. Add an audiobook from this device. Select several files to add a book with multiple parts. Files play from where they are stored and are never uploaded.</p>}
          {books.map((b) => <Row key={b.id} b={b} onOpen={() => open(b)} onEdit={() => setEdit(b)} />)}
        </main>
      )}
      {naming && <Naming n={naming} onCancel={() => setNaming(null)} onDone={async (t) => { const n = naming; setNaming(null); try { await begin(await createBook(n.items, n.fps, n.id, n.m, t), n.items); } catch { setMsg('Could not add that audiobook.'); } }} />}
      {order && <Order items={order} onCancel={() => setOrder(null)} onDone={finishAdd} />}
      {edit && <Edit b={edit} onClose={async () => { setEdit(null); await refresh(); }} onRemove={async () => { await removeBook(edit); setEdit(null); setCur(null); refresh(); }} />}
      {setup && <Setup onClose={() => { setSetup(false); syncMeta(); }} />}
    </div>
  );
}

function Row({ b, onOpen, onEdit }) {
  const c = useCover(b);
  const n = b.parts.length, frac = b.duration ? Math.min(1, (b.position || 0) / b.duration) : 0;
  const pct = b.finished ? 100 : ((b.part || 0) + frac) / n * 100;
  return (
    <div className="row">
      <button className="rowmain" onClick={onOpen}>
        <span className="cv" style={c ? { backgroundImage: `url(${c})` } : null}>{!c && b.title[0]}</span>
        <span className="meta"><b>{b.title}</b><i>{b.author || 'Unknown author'}</i>
          <span className="bar"><span style={{ width: pct + '%' }} /></span>
          <small>{b.finished ? 'Finished' : !b.updatedAt ? (n > 1 ? `${n} parts` : 'Not started') : n > 1 ? `Part ${(b.part || 0) + 1} of ${n}, at ${fmt(b.position)}` : `${fmt((b.duration || 0) - b.position)} left`}</small></span>
      </button>
      <button className="ghost" onClick={onEdit}>Edit</button>
    </div>
  );
}

function Player({ book, files, onSave, onBack, onEdit }) {
  const a = useRef(), urlRef = useRef(''), partRef = useRef(0), startAt = useRef(0), started = useRef(false);
  const cover = useCover(book);
  const [t, setT] = useState(0), [dur, setDur] = useState(0), [playing, setPlaying] = useState(false), [rate, setRate] = useState(1), [badge, setBadge] = useState(''), [part, setPart] = useState(0);
  const tap = useRef({ n: 0, dir: 0, timer: 0 });
  const [dim, setDim] = useState(false);
  const enterDim = () => { setDim(true); document.documentElement.requestFullscreen?.().catch(() => {}); };
  const leaveDim = () => { setDim(false); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); };
  useEffect(() => { const f = () => !document.fullscreenElement && setDim(false); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);

  const load = (i, at = 0, play = false) => {
    const el = a.current;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(new Blob([files[i]], { type: mime(files[i]) }));
    partRef.current = i; startAt.current = at; setPart(i);
    el.src = urlRef.current;
    el.playbackRate = rate;
    if (play) el.play();
  };
  // Stores where playback stopped. Every start goes back 10 seconds from this.
  const save = (keepalive) => {
    const el = a.current;
    if (!el || !started.current || el.ended) return;
    onSave({ part: partRef.current, position: el.currentTime, duration: el.duration || dur, finished: false }, keepalive);
  };
  const toggle = () => { const el = a.current; el.paused ? el.play() : el.pause(); };
  const seek = (v) => { const el = a.current; el.currentTime = Math.min(Math.max(0, v), el.duration || v); setT(el.currentTime); };
  const skip = (dir) => {
    const k = tap.current;
    k.n = k.timer && k.dir === dir ? k.n + 1 : 1; k.dir = dir;
    clearTimeout(k.timer);
    seek(a.current.currentTime + dir * 10);
    setBadge(`${dir > 0 ? '+' : '-'}${k.n * 10}s`);
    k.timer = setTimeout(() => { k.timer = 0; setBadge(''); }, 700);
  };
  const ended = () => {
    const i = partRef.current;
    if (i < files.length - 1) { onSave({ part: i + 1, position: 0, finished: false }); load(i + 1, 0, true); }
    else onSave({ part: 0, position: 0, finished: true });
  };

  useEffect(() => {
    const el = a.current;
    const fresh = !book.finished;
    load(fresh ? Math.min(book.part || 0, files.length - 1) : 0, fresh ? Math.max(0, (book.position || 0) - 10) : 0);
    const onMeta = () => { setDur(el.duration); if (startAt.current) el.currentTime = Math.min(startAt.current, el.duration - 1); startAt.current = 0; setT(el.currentTime); };
    el.addEventListener('loadedmetadata', onMeta);
    const hide = () => document.visibilityState !== 'visible' && save(true);
    const iv = setInterval(() => !el.paused && save(false), 30000);
    const key = (e) => {
      if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      if (e.code === 'ArrowLeft') skip(-1);
      if (e.code === 'ArrowRight') skip(1);
    };
    addEventListener('keydown', key); addEventListener('pagehide', hide); document.addEventListener('visibilitychange', hide);
    return () => { clearInterval(iv); removeEventListener('keydown', key); removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', hide); el.removeEventListener('loadedmetadata', onMeta); save(false); el.pause(); URL.revokeObjectURL(urlRef.current); };
  }, []);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title: book.title, artist: book.author, artwork: [{ src: cover || '/icon-512.png', sizes: '512x512' }] });
    // Taskbar, lock screen and keyboard media keys: previous and next skip 10 seconds back and forward.
    const h = { play: () => a.current.play(), pause: () => a.current.pause(), previoustrack: () => skip(-1), nexttrack: () => skip(1), seekbackward: () => skip(-1), seekforward: () => skip(1), seekto: (d) => seek(d.seekTime) };
    for (const [k, fn] of Object.entries(h)) { try { ms.setActionHandler(k, fn); } catch {} }
  }, [book.title, book.author, cover]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);
  useEffect(() => {
    if (!('mediaSession' in navigator) || !dur) return;
    try { navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(t, dur), playbackRate: rate }); } catch {}
  }, [Math.floor(t / 5), dur, rate]);

  const speeds = [1, 1.25, 1.5, 1.75, 2, 0.75];
  return (
    <section className="player">
      <audio ref={a} onTimeUpdate={(e) => setT(e.target.currentTime)} onPlay={() => { started.current = true; setPlaying(true); }} onPause={() => { setPlaying(false); save(false); }} onEnded={ended} />
      <div className="top"><button className="ghost" onClick={onBack}>Library</button><span><button className="ghost" onClick={enterDim}>Dim</button><button className="ghost" onClick={onEdit}>Edit</button></span></div>
      <div className="art" style={cover ? { backgroundImage: `url(${cover})` } : null}>{!cover && book.title[0]}{badge && <span className="badge">{badge}</span>}</div>
      <h2>{book.title}</h2><p className="by">{book.author}</p>
      {files.length > 1 && (
        <div className="partnav">
          <button className="ghost" disabled={part === 0} onClick={() => load(part - 1, 0, playing)}>Previous part</button>
          <span>Part {part + 1} of {files.length}</span>
          <button className="ghost" disabled={part === files.length - 1} onClick={() => load(part + 1, 0, playing)}>Next part</button>
        </div>
      )}
      <input className="seek" type="range" min="0" max={dur || 0} step="1" value={t} style={{ '--p': dur ? (t / dur) * 100 + '%' : '0%' }} onChange={(e) => seek(+e.target.value)} />
      <div className="times"><span>{fmt(t)}</span><span>-{fmt(dur - t)}</span></div>
      <div className="ctl">
        <button className="ghost speed" onClick={() => { const r = speeds[speeds.indexOf(rate) + 1] || 1; setRate(r); a.current.playbackRate = r; }}>{rate}x</button>
        <button className="skip" aria-label="Back 10 seconds" onClick={() => skip(-1)}>-10</button>
        <button className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>{playing ? <svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg> : <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>}</button>
        <button className="skip" aria-label="Forward 10 seconds" onClick={() => skip(1)}>+10</button>
        <span className="speed" />
      </div>
      {dim && <div className="dim" onClick={leaveDim}><h2>{book.title}</h2></div>}
    </section>
  );
}

function Order({ items, onDone, onCancel }) {
  const [l, setL] = useState(items);
  const mv = (i, d) => { const n = [...l]; [n[i], n[i + d]] = [n[i + d], n[i]]; setL(n); };
  return (
    <div className="modal"><div className="sheet">
      <h3>Set the order of the parts</h3>
      <p className="by" style={{ margin: 0 }}>First at the top. The parts play in this order as one audiobook.</p>
      <ol className="parts">{l.map((it, i) => (
        <li key={it.file.name + i}><span>{i + 1}. {it.file.name}</span>
          <button className="ghost" disabled={!i} onClick={() => mv(i, -1)}>Up</button>
          <button className="ghost" disabled={i === l.length - 1} onClick={() => mv(i, 1)}>Down</button></li>
      ))}</ol>
      <div className="actions"><button className="ghost" onClick={onCancel}>Cancel</button><button className="primary" onClick={() => onDone(l)}>Confirm order</button></div>
    </div></div>
  );
}

function Edit({ b, onClose, onRemove }) {
  const [title, setTitle] = useState(b.title), [author, setAuthor] = useState(b.author || ''), [res, setRes] = useState([]), [busy, setBusy] = useState(false), [cover, setCover] = useState(null);
  const find = async () => { setBusy(true); try { setRes(await searchBooks(title)); } catch { setRes([]); } setBusy(false); };
  const save = async () => {
    const cur = await getBook(b.id);
    const nb = { ...cur, title: title.trim() || cur.title, author, metaAt: Date.now(), ...(cover ? { coverUrl: cover } : {}) };
    await putBook(nb);
    pushMeta(nb).catch(() => {});
    onClose();
  };
  return (
    <div className="modal"><div className="sheet">
      <h3>Book details</h3>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Author<input value={author} onChange={(e) => setAuthor(e.target.value)} /></label>
      <button className="ghost" onClick={find} disabled={busy || !title}>{busy ? 'Searching' : 'Find cover and author online'}</button>
      {res.map((r, i) => <button key={i} className="hit" onClick={() => { setTitle(r.title); setAuthor(r.author); setCover(r.coverUrl); setRes([]); }}>{r.coverUrl && <img src={r.coverUrl} alt="" />}<span><b>{r.title}</b><i>{r.author}</i></span></button>)}
      <button className="ghost" onClick={async () => { if (confirm('Remove this book from this device? Your listening position stays synced.')) await onRemove(); }}>Remove from this device</button>
      <div className="actions"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></div>
    </div></div>
  );
}

function Setup({ onClose }) {
  const first = !device();
  const [name, setName] = useState(device() || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Phone' : 'PC'));
  const [k, setK] = useState(localStorage.getItem('syncKey') || ''), [s, setS] = useState('');
  const save = async () => {
    localStorage.setItem('deviceName', name.trim() || 'Device');
    localStorage.setItem('syncKey', k.trim());
    if (!k.trim()) return onClose();
    try { await pull(); onClose(); } catch { setS('Could not connect. Check the key and that the server is set up.'); }
  };
  return (
    <div className="modal"><div className="sheet">
      <h3>{first ? 'Set up this device' : 'Device and sync'}</h3>
      <p className="by" style={{ margin: 0 }}>The device name is shown on your other devices, for example PC VALAR. Enter the same sync key (the SYNC_KEY from Vercel) on every device. Everything else syncs automatically.</p>
      <label>Device name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Sync key<input type="password" value={k} onChange={(e) => setK(e.target.value)} /></label>
      {s && <p className="note">{s}</p>}
      <div className="actions">{!first && <button className="ghost" onClick={onClose}>Cancel</button>}<button className="primary" onClick={save}>Save</button></div>
    </div></div>
  );
}

function Naming({ n, onCancel, onDone }) {
  const [t, setT] = useState(n.guess);
  return (
    <div className="modal"><div className="sheet">
      <h3>What is this book called?</h3>
      <p className="by" style={{ margin: 0 }}>The file has no title. Enter the book name and AURIS finds the author and cover online.</p>
      <label>Book name<input autoFocus value={t} onChange={(e) => setT(e.target.value)} /></label>
      <div className="actions"><button className="ghost" onClick={onCancel}>Cancel</button><button className="primary" disabled={!t.trim()} onClick={() => onDone(t.trim())}>Continue</button></div>
    </div></div>
  );
}

