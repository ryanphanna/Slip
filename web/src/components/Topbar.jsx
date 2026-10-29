const NAV_VIEWS = [['receipts', 'Receipts'], ['items', 'Items'], ['settings', 'Settings']];

function SearchToggle({ open, onToggle, value, onChange, placeholder }) {
  return <>
    {open && <input className="header-search" autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />}
    <button aria-expanded={open} onClick={onToggle}>Search</button>
  </>;
}

export default function Topbar({ view, onNavigate, receiptSearch, itemSearch, notificationCount, onSignOut }) {
  return <header className="topbar">
    <div className="topbar-brand">
      <button className="brand-home" onClick={() => onNavigate('receipts')} aria-label="Go to receipts"><p className="eyebrow">Slip</p></button>
    </div>
    <nav className="view-nav">
      {NAV_VIEWS.map(([key, label]) => <button key={key} className={view === key ? 'active' : ''} onClick={() => onNavigate(key)}>{label}</button>)}
    </nav>
    <div className="topbar-tools">
      {view === 'receipts' && <SearchToggle {...receiptSearch} placeholder="Search receipts" />}
      {view === 'items' && <SearchToggle {...itemSearch} placeholder="Search items or merchants" />}
      <button className={view === 'notifications' ? 'notification active' : 'notification'} onClick={() => onNavigate('notifications')}>Notifications {notificationCount > 0 && <span className="notification-count">{notificationCount}</span>}</button>
      <button className="account-button" onClick={onSignOut}>Sign out</button>
    </div>
  </header>;
}
