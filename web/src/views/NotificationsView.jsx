import { useState } from 'react';
import AlsoSpent from '../components/AlsoSpent.jsx';
import CategoryBar from '../components/CategoryBar.jsx';
import FailureRow from '../components/FailureRow.jsx';
import { countLabel, formatFailureRange, formatMoney } from '../format.js';

// Recap notifications store their month as monthKey; older ones only have it in the id ("<digits>_2026-09").
export function recapMonthKey(notification) {
  if (/^\d{4}-\d{2}$/.test(notification.monthKey || '')) return notification.monthKey;
  const fromId = String(notification.id || '').match(/_(\d{4}-\d{2})$/);
  return fromId ? fromId[1] : null;
}

function RecapCard({ notification, onOpen }) {
  const monthKey = recapMonthKey(notification);
  const open = monthKey && onOpen ? () => onOpen(monthKey) : null;
  // The whole card opens the recap page; keys pressed on a legend entry stay with the entry.
  const linkProps = open ? {
    role: 'link',
    tabIndex: 0,
    'aria-label': `Open ${notification.title}`,
    onClick: open,
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      open();
    },
  } : {};
  return <article className={open ? 'card notification-card clickable' : 'card notification-card'} {...linkProps}>
    <div>
      <p className="eyebrow">Monthly summary</p>
      <h3>{notification.title}</h3>
      <strong>{formatMoney(notification.total)} <span className="muted">across {countLabel(notification.count, 'receipt')}</span></strong>
      <AlsoSpent byCurrency={notification.byCurrency} />
    </div>
    <CategoryBar categories={notification.categories} />
  </article>;
}

function ProcessingHistory({ failures, onRetry }) {
  const [showFailures, setShowFailures] = useState(false);
  return <section className="card failures">
    <div className="failure-summary">
      <span>
        <h3>Processing history</h3>
        <p className="muted">{failures.length} {failures.length === 1 ? 'receipt needs' : 'receipts need'} processing {formatFailureRange(failures)}.</p>
      </span>
      <button onClick={() => setShowFailures((visible) => !visible)}>{showFailures ? 'Hide receipts' : 'Review receipts'}</button>
    </div>
    {showFailures && <div className="failure-list">
      <p className="muted">These receipts were not added to your inbox. Retry one to process it again.</p>
      {failures.map((failure) => <FailureRow key={failure.id} failure={failure} onRetry={onRetry} />)}
    </div>}
  </section>;
}

export default function NotificationsView({ failures, notifications, onRetry, onOpenRecap }) {
  return <section className="notifications-page card-stack">
    {notifications.map((notification) => <RecapCard key={notification.id} notification={notification} onOpen={onOpenRecap} />)}
    {failures.length > 0 && <ProcessingHistory failures={failures} onRetry={onRetry} />}
    {notifications.length === 0 && failures.length === 0 && <div className="card empty notification-empty">
      <h3>You're all caught up.</h3>
      <p>Monthly summaries and other updates will appear here.</p>
    </div>}
  </section>;
}
