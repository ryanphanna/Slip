import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, RecaptchaVerifier, signInWithPhoneNumber, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import './styles.css';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const isConfigured = Object.values(firebaseConfig).every(Boolean);
const app = isConfigured ? (getApps().length ? getApp() : initializeApp(firebaseConfig)) : null;
const auth = app ? getAuth(app) : null;
const functions = app ? getFunctions(app) : null;
const call = (name, data) => httpsCallable(functions, name)(data).then((result) => result.data);

function normalizePhone(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return String(value || '').trim().replace(/[^\d+]/g, '');
}

function formatMoney(value, currency = 'CAD') {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(value);
}

function formatFailureDate(createdAt, numMedia) {
  const seconds = createdAt?.seconds ?? createdAt?._seconds;
  const date = createdAt?.toDate?.() || (seconds ? new Date(seconds * 1000) : null);
  const source = numMedia > 0 ? 'photo receipt' : 'pasted receipt';
  return `${date ? date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unprocessed'} · ${source}`;
}

function FailureRow({ failure, onRetry }) {
  const [image, setImage] = useState(null);
  useEffect(() => {
    call('getProcessingFailureImageUrls', { id: failure.id }).then(({ urls }) => setImage(urls?.[0] || null)).catch(() => {});
  }, [failure.id]);
  return <div className="failure-row"><span className="failure-info">{image ? <img src={image} alt="Receipt awaiting processing" /> : <span className="failure-placeholder">Receipt</span>}<span><strong>{formatFailureDate(failure.createdAt, failure.numMedia)}</strong><small>Slip couldn’t read this receipt.</small></span></span><button onClick={() => onRetry(failure.id)}>Retry</button></div>;
}

function Login() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [message, setMessage] = useState('');
  const recaptcha = useRef(null);

  useEffect(() => {
    if (!recaptcha.current) recaptcha.current = new RecaptchaVerifier(auth, 'recaptcha', { size: 'invisible' });
    return () => recaptcha.current?.clear();
  }, []);

  async function sendCode(event) {
    event.preventDefault();
    const normalizedPhone = normalizePhone(phone);
    if (!/^\+\d{8,15}$/.test(normalizedPhone)) {
      setMessage('Enter a valid phone number, such as (416) 555-1234.');
      return;
    }
    setMessage('Sending code…');
    try {
      setConfirmation(await signInWithPhoneNumber(auth, normalizedPhone, recaptcha.current));
      setMessage('Enter the six-digit code we texted you.');
    } catch (error) {
      setMessage(error.message || 'Could not send a code.');
    }
  }

  async function verifyCode(event) {
    event.preventDefault();
    setMessage('Verifying…');
    try {
      await confirmation.confirm(code);
    } catch (error) {
      setMessage(error.message || 'That code did not work.');
    }
  }

  return <main className="auth-card">
    <p className="eyebrow">SLIP</p>
    <h1>Your receipts, without the shoebox.</h1>
    <p className="muted">Sign in with the phone number you use to text receipts to Slip.</p>
    {!confirmation ? <form onSubmit={sendCode}>
      <label>Phone number<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 416 555 1234" required /></label>
      <button type="submit">Text me a code</button>
    </form> : <form onSubmit={verifyCode}>
      <label>Verification code<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required /></label>
      <button type="submit">Sign in</button>
    </form>}
    <div id="recaptcha" />
    {message && <p className="status">{message}</p>}
  </main>;
}

function SetupRequired() {
  return <main className="auth-card"><p className="eyebrow">SLIP</p><h1>One small setup step.</h1><p className="muted">The web app is built, but Firebase configuration has not been provided for this environment. Add the values from <code>web/.env.example</code> as frontend environment variables, then reload.</p></main>;
}

function ReceiptRow({ receipt, onSelect }) {
  return <button className="receipt-row" onClick={() => onSelect(receipt)}>
    <span className="receipt-date">{receipt.date || 'No date'}</span>
    <span className="receipt-name">{receipt.merchant || 'Unknown merchant'}<small>{receipt.category || 'Other'} · {receipt.items?.length || 0} items</small></span>
    <strong className={receipt.type === 'refund' ? 'refund' : ''}>{formatMoney(receipt.total, receipt.currency)}</strong>
  </button>;
}

function ReceiptDetail({ receipt, onClose, onSaved }) {
  const [draft, setDraft] = useState({ ...receipt, items: receipt.items || [] });
  const [images, setImages] = useState([]);
  const [zoomedImage, setZoomedImage] = useState(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setDraft({ ...receipt, items: receipt.items || [] });
    setStatus('');
    call('getReceiptImageUrls', { id: receipt.id }).then(({ urls }) => setImages(urls)).catch(() => setStatus('The receipt image could not be loaded.'));
  }, [receipt.id]);

  const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  async function save(event) {
    event.preventDefault();
    setStatus('Saving…');
    try {
      const result = await call('updateReceipt', { id: receipt.id, patch: {
        merchant: draft.merchant, location: draft.location, date: draft.date,
        total: Number(draft.total), subtotal: Number(draft.subtotal), tax: Number(draft.tax),
        category: draft.category, subCategory: draft.subCategory, items: draft.items,
      } });
      setStatus('Saved.');
      onSaved(result);
    } catch (error) { setStatus(error.message || 'Could not save.'); }
  }

  return <aside className="detail-panel">
    <div className="detail-header"><div><p className="eyebrow">RECEIPT DETAIL</p><h2>{receipt.merchant || 'Unknown merchant'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
    {images.length > 0 && <div className="image-strip">{images.map((url) => <button className="image-button" key={url} onClick={() => setZoomedImage(url)}><img src={url} alt="Original receipt; click to enlarge" /></button>)}</div>}
    <form onSubmit={save} className="detail-form">
      <div className="field-grid">
        <label>Merchant<input value={draft.merchant || ''} onChange={(e) => update('merchant', e.target.value)} /></label>
        <label>Date<input type="date" value={draft.date || ''} onChange={(e) => update('date', e.target.value)} /></label>
        <label>Total<input type="number" step="0.01" value={draft.total ?? ''} onChange={(e) => update('total', e.target.value)} /></label>
        <label>Category<input value={draft.category || ''} onChange={(e) => update('category', e.target.value)} /></label>
      </div>
      <p className="meta">{receipt.type === 'refund' ? 'Refund' : 'Purchase'}</p>
      <h3>Items</h3>
      <div className="items">{draft.items.map((item, index) => <div className="item-row" key={`${item.name}-${index}`}><input value={item.name} onChange={(e) => update('items', draft.items.map((current, i) => i === index ? { ...current, name: e.target.value } : current))} /><input aria-label={`Quantity for ${item.name}`} type="number" min="1" step="1" value={item.quantity ?? 1} onChange={(e) => update('items', draft.items.map((current, i) => i === index ? { ...current, quantity: Number(e.target.value) } : current))} /><input aria-label={`Price for ${item.name}`} type="number" step="0.01" value={item.price ?? ''} onChange={(e) => update('items', draft.items.map((current, i) => i === index ? { ...current, price: Number(e.target.value) } : current))} /></div>)}</div>
      <div className="actions"><button type="submit">Save corrections</button><button type="button" className="secondary" onClick={() => setDraft({ ...receipt, items: receipt.items || [] })}>Reset</button></div>
      {status && <p className="status">{status}</p>}
    </form>
    {zoomedImage && <div className="image-modal" role="dialog" aria-label="Expanded receipt image" onClick={() => setZoomedImage(null)}><button className="image-modal-close" aria-label="Close expanded image" onClick={() => setZoomedImage(null)}>×</button><img src={zoomedImage} alt="Expanded original receipt" onClick={(event) => event.stopPropagation()} /></div>}
  </aside>;
}

function ItemsView({ receipts, onReceiptUpdated }) {
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('verified');
  const items = useMemo(() => receipts.flatMap((receipt) => (receipt.items || []).map((item, index) => ({
    ...item,
    id: `${receipt.id}-${index}`,
    receiptId: receipt.id,
    index,
    merchant: receipt.merchant || 'Unknown merchant',
    date: receipt.date || 'No date',
  }))), [receipts]);
  const visibleItems = items.filter((item) => mode === 'verified' ? item.verified === true : item.verified !== true);
  const filtered = visibleItems.filter((item) => `${item.name} ${item.category} ${item.merchant}`.toLowerCase().includes(search.toLowerCase()));

  async function verifyItem(item) {
    const receipt = receipts.find((candidate) => candidate.id === item.receiptId);
    if (!receipt) return;
    const updated = await call('updateReceipt', { id: receipt.id, patch: { items: receipt.items.map((current, index) => index === item.index ? { ...current, verified: true } : current) } });
    onReceiptUpdated(updated);
  }

  return <section className="items-page">
    <div className="item-tabs"><button className={mode === 'verified' ? 'active' : 'secondary'} onClick={() => setMode('verified')}>Verified</button><button className={mode === 'review' ? 'active' : 'secondary'} onClick={() => setMode('review')}>Needs review</button></div>
    <div className="toolbar"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items or merchants" /><span className="count">{filtered.length} items</span></div>
    {filtered.length === 0 ? <div className="empty"><h2>{mode === 'verified' ? 'No verified items yet.' : 'Nothing needs review.'}</h2><p>{mode === 'verified' ? 'Approve items from the Needs review tab before they appear here.' : 'Newly captured items will appear here for approval.'}</p></div> : <div className="item-list">{filtered.map((item) => <div className="catalog-item" key={item.id}><div><strong>{item.name || 'Unnamed item'}</strong><small>{item.merchant} · {item.date}{item.category ? ` · ${item.category}` : ''}</small></div><span className="item-action"><span>×{item.quantity || 1}</span><strong>{formatMoney(item.price)}</strong>{mode === 'review' && <button onClick={() => verifyItem(item)}>Approve</button>}</span></div>)}</div>}
  </section>;
}

function Inbox({ user }) {
  const [receipts, setReceipts] = useState([]);
  const [failures, setFailures] = useState([]);
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState('receipts');
  const [showFailureHistory, setShowFailureHistory] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [result, failureResult] = await Promise.all([
        call('listReceipts', { limit: 100 }),
        call('listProcessingFailures', {}),
      ]);
      setReceipts(result.receipts || []);
      setFailures(failureResult.failures || []);
      setError('');
    }
    catch (err) { setError(err.message || 'Could not load receipts.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  const filtered = receipts.filter((receipt) => `${receipt.merchant} ${receipt.category} ${receipt.items?.map((i) => i.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()));

  return <main className="app-shell">
    <header className="topbar"><div><p className="eyebrow">SLIP / RECEIPTS</p><h1>{view === 'items' ? 'Items' : 'Inbox'}</h1><nav className="view-nav"><button className={view === 'receipts' ? 'active' : 'secondary'} onClick={() => setView('receipts')}>Receipts</button><button className={view === 'items' ? 'active' : 'secondary'} onClick={() => setView('items')}>Items</button></nav></div><div className="account"><span>{user.phoneNumber}</span><button className="secondary" onClick={() => signOut(auth)}>Sign out</button></div></header>
    {loading && <p className="empty">Loading your receipts…</p>}
    {!loading && error && <p className="error">{error}</p>}
    {!loading && !error && view === 'items' && <ItemsView receipts={receipts} onReceiptUpdated={(updated) => setReceipts((all) => all.map((receipt) => receipt.id === updated.id ? { ...receipt, ...updated } : receipt))} />}
    {!loading && !error && view === 'receipts' && <>
      <section className="toolbar"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search merchants, categories, or items" /><span className="count">{filtered.length} receipts</span></section>
      {filtered.length === 0 && <div className="empty"><h2>No receipts here yet.</h2><p>Text a receipt photo to Slip and it will appear in this inbox.</p></div>}
      {failures.length > 0 && <><div className="failure-access"><span>{failures.length} receipt{failures.length === 1 ? '' : 's'} need processing history</span><button className="secondary" onClick={() => setShowFailureHistory((visible) => !visible)}>{showFailureHistory ? 'Hide processing history' : 'View processing history'}</button></div>{showFailureHistory && <section className="failures"><div><h2>Processing history</h2><p className="muted">These receipts were not added to your inbox. Retry one to process it again.</p></div>{failures.map((failure) => <FailureRow key={failure.id} failure={failure} onRetry={async (id) => { try { await call('retryProcessing', { id }); setFailures((all) => all.filter((item) => item.id !== id)); await load(); } catch (err) { setError(err.message || 'Could not retry receipt.'); } }} />)}</section>}</>}
      <div className="receipt-list">{filtered.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} onSelect={setSelected} />)}</div>
    </>}
    {selected && <ReceiptDetail receipt={selected} onClose={() => setSelected(null)} onSaved={(updated) => { setReceipts((all) => all.map((r) => r.id === updated.id ? { ...r, ...updated } : r)); setSelected((current) => ({ ...current, ...updated })); }} />}
  </main>;
}

function App() {
  const [user, setUser] = useState(undefined);
  useEffect(() => isConfigured ? onAuthStateChanged(auth, setUser) : undefined, []);
  if (!isConfigured) return <SetupRequired />;
  if (user === undefined) return <p className="loading">Loading Slip…</p>;
  return user ? <Inbox user={user} /> : <Login />;
}

createRoot(document.getElementById('root')).render(<App />);
