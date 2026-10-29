import { useEffect, useState } from 'react';
import { call } from '../firebase.js';
import { countLabel, formatListDate } from '../format.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const monthLabel = (monthKey) => MONTHS[Number(monthKey.slice(5, 7)) - 1];
const formatPoints = (value) => value.toLocaleString('en-CA', { maximumFractionDigits: 2 });

function ProgramCard({ program, onOpenReceipt }) {
  const earned = program.earnedByMonth.filter((month) => month.points > 0);
  const showStores = program.stores.length > 1;
  return <article className="card recap-section points-card">
    <h3>{program.name}</h3>
    {showStores && <p className="muted points-stores">{program.stores.join(', ')}</p>}
    {program.balance != null
      ? <>
        <strong className="points-balance">{formatPoints(program.balance)} <span className="muted">points</span></strong>
        <p className="muted points-as-of">
          As of {formatListDate(program.balanceDate)} at{' '}
          <button className="toolbar-link" onClick={() => onOpenReceipt(program.balanceReceiptId)}>{program.balanceStore}</button>
        </p>
      </>
      : <p className="muted points-as-of">No balance printed on {countLabel(program.receiptCount, 'receipt')}</p>}
    {earned.length > 0 && <>
      <h4>Points earned</h4>
      <ol className="recap-stores points-months">
        {program.earnedByMonth.map((month) => <li key={month.monthKey}>
          <span>{monthLabel(month.monthKey)}</span>
          <strong>{month.points > 0 ? formatPoints(month.points) : <span className="muted">—</span>}</strong>
        </li>)}
      </ol>
    </>}
  </article>;
}

// Loyalty points per program, read from the points printed on receipts (CIV-1130).
export default function PointsView({ version, onSelect }) {
  const [programs, setPrograms] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    call('getPoints')
      .then((result) => { if (current) setPrograms(result.programs || []); })
      .catch((err) => { if (current) setError(err.message || 'Could not load points.'); });
    return () => { current = false; };
  }, [version]);

  async function openReceipt(id) {
    try { onSelect(await call('getReceipt', { id })); }
    catch (err) { setError(err.message || 'Could not open that receipt.'); }
  }

  if (error) return <section className="recap-page card-stack"><p className="error">{error}</p></section>;
  if (!programs) return <section className="recap-page card-stack"><p className="empty">Loading…</p></section>;
  if (programs.length === 0) return <section className="recap-page card-stack"><p className="empty">No points found on your receipts yet.</p></section>;

  return <section className="recap-page card-stack">
    <p className="muted points-intro">Each balance is the one printed on your latest receipt from that program.</p>
    {programs.map((program) => <ProgramCard key={program.name} program={program} onOpenReceipt={openReceipt} />)}
  </section>;
}
