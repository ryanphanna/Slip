import { useEffect, useState } from 'react';
import AlsoSpent from '../components/AlsoSpent.jsx';
import CategoryBar from '../components/CategoryBar.jsx';
import ReceiptRow from '../components/ReceiptRow.jsx';
import { call } from '../firebase.js';
import { comparisonLabel, countLabel, formatMoney } from '../format.js';

function categoryNotes(recap) {
  const previousMonth = recap.previous.month;
  const before = recap.previous.categories || {};
  return Object.fromEntries(Object.entries(recap.categories || {}).map(([name, amount]) => [
    name,
    before[name] > 0 ? comparisonLabel(amount, before[name], previousMonth) : `Nothing in ${previousMonth}`,
  ]));
}

// Categories spent on last month but not at all this month, so every change is listed.
function droppedCategories(recap) {
  const now = recap.categories || {};
  return Object.entries(recap.previous.categories || {})
    .filter(([name, amount]) => amount > 0 && !(now[name] > 0))
    .sort((a, b) => b[1] - a[1]);
}

function totalComparison(recap) {
  const { previous } = recap;
  if (previous.count === 0 && !previous.total) return `Nothing recorded in ${previous.month}`;
  return comparisonLabel(recap.total, previous.total, previous.month);
}

// Full page for one monthly recap (CIV-1073): every category, the change from
// the month before, top stores and that month's receipts.
export default function RecapView({ month, version, onBack, onSelect }) {
  const [recap, setRecap] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setError('');
    call('getMonthlyRecap', { month })
      .then((result) => { if (current) setRecap(result); })
      .catch((err) => { if (current) setError(err.message || 'Could not load this recap.'); });
    return () => { current = false; };
  }, [month, version]);

  const back = <button className="toolbar-link recap-back" onClick={onBack}>Back to notifications</button>;
  if (error) return <section className="recap-page card-stack">{back}<p className="error">{error}</p></section>;
  if (!recap || recap.monthKey !== month) return <section className="recap-page card-stack">{back}<p className="empty">Loading…</p></section>;

  const dropped = droppedCategories(recap);
  return <section className="recap-page card-stack">
    {back}
    <article className="card notification-card">
      <div>
        <p className="eyebrow">Monthly summary</p>
        <h3>{recap.month} {recap.year} recap</h3>
        <strong>{formatMoney(recap.total)} <span className="muted">across {countLabel(recap.count, 'receipt')}</span></strong>
        <p className="muted recap-change">{totalComparison(recap)}</p>
        <AlsoSpent byCurrency={recap.byCurrency} />
      </div>
      <CategoryBar categories={recap.categories} showAll notes={categoryNotes(recap)} />
      {dropped.length > 0 && <p className="muted recap-dropped">Nothing this month in {dropped.map(([name, amount], index) => <span key={name}>{index > 0 && ', '}<span className="also-spent-entry">{name} ({formatMoney(amount)} in {recap.previous.month})</span></span>)}</p>}
    </article>

    {recap.topMerchants.length > 0 && <article className="card recap-section">
      <h3>Top stores</h3>
      <ol className="recap-stores">
        {recap.topMerchants.map((store) => <li key={store.name}>
          <span className="recap-store-name">{store.name}<small className="muted">{countLabel(store.count, 'receipt')}</small></span>
          <strong>{formatMoney(store.total)}</strong>
        </li>)}
      </ol>
    </article>}

    <article className="card recap-section">
      <h3>Receipts</h3>
      {recap.receipts.length === 0
        ? <p className="muted">No receipts this month.</p>
        : <div className="receipt-list">{recap.receipts.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} onSelect={onSelect} />)}</div>}
    </article>
  </section>;
}
