import { useEffect, useState } from 'react';
import { call } from '../firebase.js';
import { countLabel, formatListDate, formatMoney } from '../format.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const monthLabel = (monthKey) => MONTHS[Number(monthKey.slice(5, 7)) - 1];
const formatPoints = (value) => value.toLocaleString('en-CA', { maximumFractionDigits: 2 });

// Points earned per month as small bars; the value shows on hover or focus.
function EarnedChart({ months }) {
  const max = Math.max(...months.map((month) => month.points));
  const total = months.reduce((sum, month) => sum + month.points, 0);
  return <>
    <h4>Points earned <span className="muted">{formatPoints(total)} in the last {months.length} months</span></h4>
    <div className="points-chart" role="list">
      {months.map((month) => {
        const label = `${monthLabel(month.monthKey)}: ${month.points > 0 ? `${formatPoints(month.points)} points` : 'none'}`;
        return <div key={month.monthKey} className="points-chart-month" role="listitem" tabIndex={0} aria-label={label} data-value={month.points > 0 ? formatPoints(month.points) : 'None'}>
          <div className="points-chart-track">
            {month.points > 0 && <div className="points-chart-bar" style={{ height: `${Math.max(4, (month.points / max) * 100)}%` }} />}
          </div>
          <span className="points-chart-label">{monthLabel(month.monthKey)}</span>
        </div>;
      })}
    </div>
  </>;
}

function ProgramCard({ program, onOpenReceipt }) {
  const hasEarned = program.earnedByMonth.some((month) => month.points > 0);
  const showStores = program.stores.length > 1;
  return <article className="card recap-section points-card">
    <h3>{program.name}</h3>
    {showStores && <p className="muted points-stores">{program.stores.join(', ')}</p>}
    {program.balance != null
      ? <>
        <strong className="points-balance">{formatPoints(program.balance)} <span className="muted">points</span></strong>
        {program.worthAtLeast != null && <p className="points-worth">
          Worth at least {formatMoney(program.worthAtLeast)}{' '}
          <span className="muted">({formatPoints(program.rate.points)} points = {formatMoney(program.rate.dollars).replace(/\.00$/, '')})</span>
        </p>}
        <p className="muted points-as-of">
          As of {formatListDate(program.balanceDate)} at{' '}
          <button className="toolbar-link" onClick={() => onOpenReceipt(program.balanceReceiptId)}>{program.balanceStore}</button>
        </p>
      </>
      : <p className="muted points-as-of">No balance printed on {countLabel(program.receiptCount, 'receipt')}</p>}
    {hasEarned && <EarnedChart months={program.earnedByMonth} />}
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
