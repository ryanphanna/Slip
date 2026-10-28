import { useState } from 'react';
import { categorySegments, formatMoney } from '../format.js';

export default function CategoryBar({ categories }) {
  const [activeName, setActiveName] = useState(null);
  const segments = categorySegments(categories);
  if (segments.length === 0) return null;
  const highlight = (name) => ({
    className: activeName === name ? 'active' : undefined,
    onMouseEnter: () => setActiveName(name),
    onMouseLeave: () => setActiveName(null),
  });
  return <div className={activeName ? 'category-breakdown has-active' : 'category-breakdown'}>
    <div className="category-bar" role="img" aria-label={segments.map((s) => `${s.name} ${formatMoney(s.amount)}`).join(', ')}>
      {segments.map((s) => <span key={s.name} {...highlight(s.name)} style={{ flexGrow: s.amount, background: s.color }} />)}
    </div>
    <ul className="category-legend">
      {segments.map((s) => <li key={s.name} {...highlight(s.name)} tabIndex={0} onFocus={() => setActiveName(s.name)} onBlur={() => setActiveName(null)}><i style={{ background: s.color }} /><strong>{formatMoney(s.amount)}</strong> {s.name}</li>)}
    </ul>
  </div>;
}
