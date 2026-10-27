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
  const [menu, setMenu] = useState(null);
  const [auto, setAuto] = useState(false);
  const [full, setFull] = useState(true);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'light');
  const toggleTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    setTheme(t); document.documentElement.dataset.theme = t; localStorage.setItem('theme', t);
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#2C2C2C' : '#DCDBD5');
  };
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
    refresh();
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
    setFull(true);
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
    if (cur?.book.id === b.id) return setFull(true);
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
    if (cur) return setMsg(`Added "${b.title}" to your library.`);
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
      {cur && <Player key={cur.book.id} {...cur} mini={!full} onSave={(p, k) => saveProgress(cur.book.id, p, k)} onBack={() => { setFull(false); refresh(); }} onExpand={() => setFull(true)} onClose={() => { setCur(null); refresh(); }} />}
      {(!cur || !full) && (
        <main className="lib">
          <header><h1 className="word">AURIS</h1>{inst && <button className="txtbtn" onClick={() => { inst.prompt(); setInst(null); }}>Install</button>}<button className="txtbtn" onClick={toggleTheme}>{theme === 'dark' ? 'Light' : 'Dark'}</button><button className="txtbtn" onClick={() => setSetup(true)}>{device() || 'Device'}</button></header>
          <h2 className="hl"><span>Your</span> <b>Library</b></h2>
          {msg && <p className="note" onClick={() => setMsg('')}>{msg}</p>}
          {!books.length && <p className="empty">Your library is empty. Add an audiobook from this device. Select several files to add a book with multiple parts. Files are never uploaded.</p>}
          <div className={cur ? 'grid lifted' : 'grid'}>{books.map((b) => <Card key={b.id} b={b} onOpen={() => open(b)} onMenu={setMenu} />)}</div>
          <button className={cur ? 'addbtn lifted' : 'addbtn'} onClick={add}>Add audiobook</button>
        </main>
      )}
      {menu && (
        <div className="modal" onClick={() => setMenu(null)}><div className="sheet" onClick={(e) => e.stopPropagation()}>
          <h3>{menu.title}</h3>
          <button className="opt" onClick={() => { setAuto(false); setEdit(menu); setMenu(null); }}>Edit details</button>
          <button className="opt" onClick={() => { setAuto(true); setEdit(menu); setMenu(null); }}>Change cover</button>
          <button className="opt danger" onClick={async () => { if (confirm('Remove this book from this device? Your listening position stays synced.')) { await removeBook(menu); if (cur?.book.id === menu.id) setCur(null); setMenu(null); refresh(); } }}>Remove from this device</button>
        </div></div>
      )}
      {naming && <Naming n={naming} onCancel={() => setNaming(null)} onDone={async (t) => { const n = naming; setNaming(null); try { await begin(await createBook(n.items, n.fps, n.id, n.m, t), n.items); } catch { setMsg('Could not add that audiobook.'); } }} />}
      {order && <Order items={order} onCancel={() => setOrder(null)} onDone={finishAdd} />}
      {edit && <Edit b={edit} auto={auto} onClose={async () => { setEdit(null); await refresh(); const f = cur && await getBook(cur.book.id); if (f) setCur((c) => c && { ...c, book: { ...c.book, title: f.title, author: f.author, coverUrl: f.coverUrl } }); }} />}
      {setup && <Setup onClose={() => { setSetup(false); syncMeta(); }} />}
    </div>
  );
}

const blobPath = (R, a, n) => {
  const pts = [];
  for (let i = 0; i < 120; i++) { const th = (i / 120) * 2 * Math.PI, r = R * (1 + a * Math.cos(n * th)); pts.push(`${(r * Math.sin(th)).toFixed(1)},${(-r * Math.cos(th)).toFixed(1)}`); }
  return 'M' + pts.join('L') + 'Z';
};
const SHAPE = blobPath(78, 0.05, 9), ORBIT = blobPath(92, 0.05, 9);

// Scalloped cover. With p (0 to 1) a dot travels along an outline to show progress.
function Scallop({ id, src, letter, p, tight, onSeek }) {
  const ref = useRef(), svg = useRef(), drag = useRef(false);
  const [pt, setPt] = useState([0, -92]);
  const q = p == null ? 0 : Math.min(1, Math.max(0, p || 0));
  useEffect(() => {
    if (p == null || !ref.current) return;
    const el = ref.current, s = el.getPointAtLength(el.getTotalLength() * q);
    setPt([s.x, s.y]);
  }, [q]);
  // Angle around the cover, starting at the top and going clockwise, becomes the position in the book.
  const at = (e, start) => {
    const r = svg.current.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (start && Math.hypot(dx, dy) < r.width * 0.41) return false;
    let a = Math.atan2(dx, -dy);
    if (a < 0) a += 2 * Math.PI;
    onSeek(a / (2 * Math.PI));
    return true;
  };
  const seekProps = onSeek ? {
    role: 'slider', 'aria-label': 'Seek', 'aria-valuenow': Math.round(q * 100), style: { touchAction: 'none', cursor: 'pointer' },
    onPointerDown: (e) => { if (at(e, true)) { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); } },
    onPointerMove: (e) => { if (drag.current) at(e); },
    onPointerUp: () => { drag.current = false; }, onPointerCancel: () => { drag.current = false; },
  } : { 'aria-hidden': 'true' };
  return (
    <svg ref={svg} viewBox={tight ? '-84 -84 168 168' : '-100 -100 200 200'} className="blob" {...seekProps}>
      <defs><clipPath id={id}><path d={SHAPE} /></clipPath></defs>
      <path d={SHAPE} className="bfill" />
      {src ? <image href={src} x="-78" y="-78" width="156" height="156" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${id})`} /> : <text y="20">{letter}</text>}
      {p != null && <>
        <path ref={ref} d={ORBIT} className="track" />
        <path d={ORBIT} pathLength="1" strokeDasharray={`${q} 2`} className="prog" />
        <circle cx={pt[0]} cy={pt[1]} r="4.5" className="dot" />
      </>}
    </svg>
  );
}

function Card({ b, onOpen, onMenu }) {
  const c = useCover(b), timer = useRef(0), fired = useRef(false);
  const n = b.parts.length;
  const stop = () => clearTimeout(timer.current);
  const info = b.finished ? 'Finished' : !b.updatedAt ? (n > 1 ? `${n} parts` : 'New') : n > 1 ? `Part ${(b.part || 0) + 1} of ${n}` : `${fmt((b.duration || 0) - b.position)} left`;
  return (
    <div className="card" onPointerDown={() => { fired.current = false; timer.current = setTimeout(() => { fired.current = true; onMenu(b); }, 550); }} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onContextMenu={(e) => { e.preventDefault(); fired.current = true; onMenu(b); }} onClick={() => { if (!fired.current) onOpen(); }}>
      <Scallop id={'c' + b.id.slice(0, 10)} src={c} letter={b.title[0]} tight />
      <button className="dots" aria-label={`Options for ${b.title}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onMenu(b); }}><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg></button>
      <b>{b.title}</b><small>{b.author || info}</small>{b.author && <small>{info}</small>}
    </div>
  );
}

function Player({ book, files, mini, onSave, onBack, onExpand, onClose }) {
  const a = useRef(), urlRef = useRef(''), partRef = useRef(0), startAt = useRef(0), started = useRef(false);
  const cover = useCover(book);
  const [t, setT] = useState(0), [dur, setDur] = useState(0), [playing, setPlaying] = useState(false), [rate, setRate] = useState(1), [badge, setBadge] = useState(''), [part, setPart] = useState(0);
  const tap = useRef({ n: 0, dir: 0, timer: 0 });

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
    <>
      <audio ref={a} onTimeUpdate={(e) => setT(e.target.currentTime)} onPlay={() => { started.current = true; setPlaying(true); }} onPause={() => { setPlaying(false); save(false); }} onEnded={ended} />
      {mini ? (
        <div className="mini" onClick={onExpand} role="button" aria-label="Open player">
          <span className="mbar"><span style={{ width: (dur ? (t / dur) * 100 : 0) + '%' }} /></span>
          <Scallop id="mini" src={cover} letter={book.title[0]} tight />
          <span className="mt"><b>{book.title}</b><small>{book.author}</small></span>
          <button className="mbtn main" aria-label={playing ? 'Pause' : 'Play'} onClick={(e) => { e.stopPropagation(); toggle(); }}>{playing ? <svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg> : <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>}</button>
          <button className="mbtn" aria-label="Close player" onClick={(e) => { e.stopPropagation(); onClose(); }}><svg className="x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
      ) : (
    <section className="player">
      <div className="top">
        <button className="circ" onClick={onBack} aria-label="Back to library"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg></button>
        <span>Now listening</span>
        <button className="circ" aria-label="Playback speed" onClick={() => { const r = speeds[speeds.indexOf(rate) + 1] || 1; setRate(r); a.current.playbackRate = r; }}>{rate}x</button>
      </div>
      <p className="clock"><b>{fmt(t)}</b> | {fmt(dur)}</p>
      <div className="art"><Scallop id="pl" src={cover} letter={book.title[0]} p={dur ? t / dur : 0} onSeek={(f) => dur && seek(f * dur)} />{badge && <span className="badge">{badge}</span>}</div>
      <h2 className="bt">{book.title}</h2><p className="by">{book.author}</p>
      {files.length > 1 && (
        <div className="partnav">
          <button className="ghost" disabled={part === 0} onClick={() => load(part - 1, 0, playing)}>Previous part</button>
          <span>Part {part + 1} of {files.length}</span>
          <button className="ghost" disabled={part === files.length - 1} onClick={() => load(part + 1, 0, playing)}>Next part</button>
        </div>
      )}
      <div className="ctl">
        <button className="sk" aria-label="Back 10 seconds" onClick={() => skip(-1)}><svg viewBox="0 0 24 24"><path d="M17 5v14L6 12z" /></svg><small>10</small></button>
        <button className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>{playing ? <svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg> : <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>}</button>
        <button className="sk" aria-label="Forward 10 seconds" onClick={() => skip(1)}><svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z" /></svg><small>10</small></button>
      </div>
    </section>
      )}
    </>
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

function Edit({ b, onClose, auto }) {
  const [title, setTitle] = useState(b.title), [author, setAuthor] = useState(b.author || ''), [res, setRes] = useState([]), [busy, setBusy] = useState(false), [cover, setCover] = useState(null);
  const find = async () => { setBusy(true); try { setRes(await searchBooks(title)); } catch { setRes([]); } setBusy(false); };
  useEffect(() => { if (auto) find(); }, []);
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
      <div className="actions"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></div>
    </div></div>
  );
}

function Setup({ onClose }) {
  const first = !device();
  const [name, setName] = useState(device() || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Phone' : 'PC'));
  const [k, setK] = useState(localStorage.getItem('syncKey') || ''), [s, setS] = useState('');
  const skip = () => { if (first) localStorage.setItem('deviceName', name.trim() || 'Device'); onClose(); };
  const save = async () => {
    localStorage.setItem('deviceName', name.trim() || 'Device');
    localStorage.setItem('syncKey', k.trim());
    if (!k.trim()) return onClose();
    try { await pull(); onClose(); } catch { setS('Could not connect. Check the key and that the server is set up.'); }
  };
  return (
    <div className="page"><div className="pagein">
      <div className="ptop"><span className="word">AURIS</span><button className="txtbtn" onClick={skip}>{first ? 'Skip' : 'Close'}</button></div>
      <div className="deco"><Scallop id="s1" src="/icon-192.png" tight /><Scallop id="s2" letter="a" tight /></div>
      <h2 className="hl"><span>Listen Anywhere,</span><br /><b>Resume Everywhere</b></h2>
      <p className="by">Name this device and enter your sync key. Your place in every book then follows you from PC to phone.</p>
      <label>Device name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Sync key<input type="password" value={k} onChange={(e) => setK(e.target.value)} /></label>
      {s && <p className="note">{s}</p>}
      <button className="addbtn static" onClick={save}>Save</button>
    </div></div>
  );
}
