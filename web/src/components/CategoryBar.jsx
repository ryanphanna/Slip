import { useState } from 'react';
import { allCategorySegments, categorySegments, formatMoney } from '../format.js';

// `showAll` lists every category (recap page) instead of the top 4 plus Other;
// `notes` adds a line under a category's legend entry, keyed by category name.
export default function CategoryBar({ categories, showAll = false, notes }) {
  const [activeName, setActiveName] = useState(null);
  const segments = showAll ? allCategorySegments(categories) : categorySegments(categories);
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
    <ul className={notes ? 'category-legend with-notes' : 'category-legend'}>
      {segments.map((s) => <li key={s.name} {...highlight(s.name)} tabIndex={0} onFocus={() => setActiveName(s.name)} onBlur={() => setActiveName(null)}>
        <i style={{ background: s.color }} />
        {notes
          ? <><span className="category-legend-name"><strong>{formatMoney(s.amount)}</strong> {s.name}</span>{notes[s.name] && <small className="muted">{notes[s.name]}</small>}</>
          : <><strong>{formatMoney(s.amount)}</strong> {s.name}</>}
      </li>)}
    </ul>
  </div>;
}
