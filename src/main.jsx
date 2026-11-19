import { Component } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Shows what went wrong instead of a blank screen, and lets the user recover.
class Boundary extends Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    const e = this.state.err;
    if (!e) return this.props.children;
    const text = `${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`;
    const btn = { padding: '12px 18px', borderRadius: 999, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', font: 'inherit', cursor: 'pointer' };
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: 24, font: '15px/1.4 system-ui, sans-serif', color: 'var(--ink)' }}>
        <h2 style={{ fontWeight: 700 }}>Something went wrong</h2>
        <p style={{ color: 'var(--mu)' }}>Your listening positions are safe on the server. Reload to try again, and send the details below if it keeps happening.</p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--card)', padding: 12, borderRadius: 12, fontSize: 12 }}>{text}</pre>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={btn} onClick={() => location.reload()}>Reload</button>
          <button style={btn} onClick={() => navigator.clipboard?.writeText(text)}>Copy details</button>
          <button style={btn} onClick={() => { if (confirm('Remove the book list stored on this device? Saved copies and synced positions are not touched, and you add your books again.')) { const r = indexedDB.deleteDatabase('auris-books'); r.onsuccess = r.onerror = r.onblocked = () => location.reload(); } }}>Reset book list</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(<Boundary><App /></Boundary>);
if ('serviceWorker' in navigator && import.meta.env.PROD) addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
