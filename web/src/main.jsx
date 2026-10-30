import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import Topbar from './components/Topbar.jsx';
import ReceiptDetail from './components/ReceiptDetail.jsx';
import { auth, call, isConfigured } from './firebase.js';
import { CATEGORIES } from './format.js';
import ItemsView from './views/ItemsView.jsx';
import Login from './views/Login.jsx';
import NotificationsView from './views/NotificationsView.jsx';
import PointsView from './views/PointsView.jsx';
import RecapView from './views/RecapView.jsx';
import ReceiptsView, { EMPTY_FILTERS } from './views/ReceiptsView.jsx';
import SettingsView from './views/SettingsView.jsx';
import SetupRequired from './views/SetupRequired.jsx';
import './styles.css';

const VIEW_PATHS = { receipts: '/', items: '/items', points: '/points', notifications: '/notifications', settings: '/settings' };
const RECAP_PATH = /^\/notifications\/recap\/(\d{4}-(?:0[1-9]|1[0-2]))\/?$/;
const recapPath = (month) => `/notifications/recap/${month}`;
function viewFromPath(pathname) {
  if (RECAP_PATH.test(pathname)) return 'recap';
  const match = Object.entries(VIEW_PATHS).find(([, path]) => path === pathname);
  return match ? match[0] : 'receipts';
}
const recapMonthFromPath = (pathname) => pathname.match(RECAP_PATH)?.[1] || null;

function Inbox({ user }) {
  const [receipts, setReceipts] = useState([]);
  const [catalogItems, setCatalogItems] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [settings, setSettings] = useState({ monthlyDigestEnabled: true });
  const [failures, setFailures] = useState([]);
  const [selected, setSelected] = useState(null);
  const [view, setViewState] = useState(() => viewFromPath(window.location.pathname));
  const [recapMonth, setRecapMonth] = useState(() => recapMonthFromPath(window.location.pathname));
  const [recapVersion, setRecapVersion] = useState(0);

  function setView(next) {
    setViewState(next);
    const path = VIEW_PATHS[next] || '/';
    if (window.location.pathname !== path) window.history.pushState({ view: next }, '', path);
  }

  function openRecap(month) {
    setRecapMonth(month);
    setViewState('recap');
    window.history.pushState({ view: 'recap', month, fromNotifications: true }, '', recapPath(month));
  }

  // Opened from Notifications: step back in history so browser Back and this control agree.
  function closeRecap() {
    if (window.history.state?.fromNotifications) window.history.back();
    else setView('notifications');
  }

  useEffect(() => {
    const onPopState = () => {
      setViewState(viewFromPath(window.location.pathname));
      setRecapMonth(recapMonthFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const [showSearch, setShowSearch] = useState(false);
  const [search, setSearch] = useState('');
  const [showItemSearch, setShowItemSearch] = useState(false);
  const [itemSearch, setItemSearch] = useState('');
  const [sortOrder, setSortOrder] = useState('newest');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load({ append = false, cursor = null } = {}) {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const [result, failureResult, itemResult, settingsResult, notificationResult] = await Promise.all([
        call('listReceipts', { limit: 20, ...(cursor ? { cursor } : {}) }),
        call('listProcessingFailures', {}),
        call('listItems', {}).catch(() => ({ items: [] })),
        call('getSettings').catch(() => ({ monthlyDigestEnabled: true })),
        call('listNotifications').catch(() => ({ notifications: [] })),
      ]);
      setReceipts((current) => append ? [...current, ...(result.receipts || [])] : (result.receipts || []));
      setNextCursor(result.nextCursor || null);
      setHasMore(result.hasMore === true);
      setCatalogItems(itemResult.items || []);
      setSettings(settingsResult);
      setNotifications(notificationResult.notifications || []);
      setFailures(failureResult.failures || []);
      setError('');
    }
    catch (err) { setError(err.message || 'Could not load receipts.'); }
    finally { setLoading(false); setLoadingMore(false); }
  }
  useEffect(() => { load(); }, []);

  const categories = [...new Set([...CATEGORIES, ...receipts.map((receipt) => receipt.category).filter(Boolean)])].sort();
  const ready = !loading && !error;

  async function retryFailure(id) {
    try {
      await call('retryProcessing', { id });
      setFailures((all) => all.filter((item) => item.id !== id));
      await load();
    } catch (err) { setError(err.message || 'Could not retry receipt.'); }
  }

  function receiptUpdated(updated) {
    if (updated) setReceipts((all) => all.map((receipt) => receipt.id === updated.id ? { ...receipt, ...updated } : receipt));
    load();
  }

  async function changeDigest(monthlyDigestEnabled) {
    const updated = await call('updateSettings', { patch: { monthlyDigestEnabled } });
    setSettings(updated);
  }

  function receiptSaved(updated) {
    setReceipts((all) => all.map((r) => r.id === updated.id ? { ...r, ...updated } : r));
    setSelected((current) => ({ ...current, ...updated }));
    setRecapVersion((version) => version + 1);
  }

  return <main className="app-shell">
    <Topbar
      view={view === 'recap' ? 'notifications' : view}
      onNavigate={setView}
      receiptSearch={{ open: showSearch, onToggle: () => setShowSearch((visible) => !visible), value: search, onChange: setSearch }}
      itemSearch={{ open: showItemSearch, onToggle: () => setShowItemSearch((visible) => !visible), value: itemSearch, onChange: setItemSearch }}
      notificationCount={failures.length + notifications.length}
      onSignOut={() => signOut(auth)}
    />
    {loading && <p className="empty">Loading…</p>}
    {!loading && error && <p className="error">{error}</p>}
    {ready && view === 'items' && <ItemsView receipts={receipts} catalogItems={catalogItems} search={itemSearch} onReceiptUpdated={receiptUpdated} />}
    {ready && view === 'notifications' && <NotificationsView failures={failures} notifications={notifications} onRetry={retryFailure} onOpenRecap={openRecap} />}
    {ready && view === 'recap' && recapMonth && <RecapView month={recapMonth} version={recapVersion} onBack={closeRecap} onSelect={setSelected} />}
    {ready && view === 'points' && <PointsView version={recapVersion} onSelect={setSelected} />}
    {ready && view === 'settings' && <SettingsView settings={settings} onDigestChange={changeDigest} />}
    {ready && view === 'receipts' && <ReceiptsView
      receipts={receipts}
      categories={categories}
      search={search}
      sortOrder={sortOrder}
      onSortChange={setSortOrder}
      showFilters={showFilters}
      onToggleFilters={() => setShowFilters((visible) => !visible)}
      filters={filters}
      onFiltersChange={setFilters}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={() => load({ append: true, cursor: nextCursor })}
      onSelect={setSelected}
    />}
    {selected && <>
      <div className="detail-backdrop" onClick={() => setSelected(null)} />
      <ReceiptDetail receipt={selected} categories={categories} onClose={() => setSelected(null)} onSaved={receiptSaved} />
    </>}
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
