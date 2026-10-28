import { useState } from 'react';
import CategoryBar from '../components/CategoryBar.jsx';
import FailureRow from '../components/FailureRow.jsx';
import { formatFailureRange, formatMoney } from '../format.js';

function receiptCount(count) {
  return `${count} ${count === 1 ? 'receipt' : 'receipts'}`;
}

function RecapCard({ notification }) {
  const otherCurrencies = Object.entries(notification.byCurrency || {});
  return <article className="card notification-card">
    <div>
      <p className="eyebrow">Monthly summary</p>
      <h3>{notification.title}</h3>
      <strong>{formatMoney(notification.total)} <span className="muted">across {notification.count} {notification.count === 1 ? 'receipt' : 'receipts'}</span></strong>
      {otherCurrencies.length > 0 && <p className="muted">Also spent: {otherCurrencies.sort(([a], [b]) => a.localeCompare(b)).map(([code, value]) => `${formatMoney(value.total, code)} (${receiptCount(value.count)})`).join(', ')}</p>}
    </div>
    <CategoryBar categories={notification.categories} />
  </article>;
}

function ProcessingHistory({ failures, onRetry }) {
  const [showFailures, setShowFailures] = useState(false);
  return <section className="card card-plain failures">
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

export default function NotificationsView({ failures, notifications, onRetry }) {
  return <section className="notifications-page">
    <h2>Notifications</h2>
    <p className="page-intro">Updates and things that need your attention.</p>
    {notifications.map((notification) => <RecapCard key={notification.id} notification={notification} />)}
    {failures.length > 0 && <ProcessingHistory failures={failures} onRetry={onRetry} />}
    {notifications.length === 0 && failures.length === 0 && <div className="card card-plain empty notification-empty">
      <h3>You're all caught up.</h3>
      <p>Monthly summaries and other updates will appear here.</p>
    </div>}
  </section>;
}
