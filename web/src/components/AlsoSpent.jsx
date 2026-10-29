import { countLabel, formatMoney } from '../format.js';

// Other-currency spending, never added into the CAD total: "Also spent: US$45.00 (2 receipts), …".
export default function AlsoSpent({ byCurrency }) {
  const otherCurrencies = Object.entries(byCurrency || {});
  if (otherCurrencies.length === 0) return null;
  return <p className="muted">Also spent: {otherCurrencies.sort(([a], [b]) => a.localeCompare(b)).map(([code, value], index) => <span key={code}>{index > 0 && ', '}<span className="also-spent-entry">{formatMoney(value.total, code)} ({countLabel(value.count, 'receipt')})</span></span>)}</p>;
}
