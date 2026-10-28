import { categorySegments, formatMoney } from '../format.js';

export default function CategoryBar({ categories }) {
  const segments = categorySegments(categories);
  if (segments.length === 0) return null;
  return <div className="category-breakdown">
    <div className="category-bar" role="img" aria-label={segments.map((s) => `${s.name} ${formatMoney(s.amount)}`).join(', ')}>
      {segments.map((s) => <span key={s.name} style={{ flexGrow: s.amount, background: s.color }} />)}
    </div>
    <ul className="category-legend">
      {segments.map((s) => <li key={s.name}><i style={{ background: s.color }} /><strong>{formatMoney(s.amount)}</strong> {s.name}</li>)}
    </ul>
  </div>;
}
