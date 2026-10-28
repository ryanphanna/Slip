import ReceiptRow from '../components/ReceiptRow.jsx';
import { countLabel } from '../format.js';

export const EMPTY_FILTERS = { category: '', startDate: '', endDate: '', minAmount: '', maxAmount: '' };

export function filterReceipts(receipts, search, filters, sortOrder) {
  return [...receipts]
    .filter((receipt) => `${receipt.merchant} ${receipt.category} ${receipt.items?.map((i) => i.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()))
    .filter((receipt) => !filters.category || receipt.category === filters.category)
    .filter((receipt) => !filters.startDate || (receipt.date || '') >= filters.startDate)
    .filter((receipt) => !filters.endDate || (receipt.date || '') <= filters.endDate)
    .filter((receipt) => filters.minAmount === '' || Number(receipt.total) >= Number(filters.minAmount))
    .filter((receipt) => filters.maxAmount === '' || Number(receipt.total) <= Number(filters.maxAmount))
    .sort((a, b) => {
      const aDate = a.date || '';
      const bDate = b.date || '';
      if (!aDate && bDate) return 1;
      if (aDate && !bDate) return -1;
      const comparison = aDate.localeCompare(bDate);
      return sortOrder === 'oldest' ? comparison : -comparison;
    });
}

export default function ReceiptsView({ receipts, categories, search, sortOrder, onSortChange, showFilters, onToggleFilters, filters, onFiltersChange, hasMore, loadingMore, onLoadMore, onSelect }) {
  const filtered = filterReceipts(receipts, search, filters, sortOrder);
  const setFilter = (field, value) => onFiltersChange((current) => ({ ...current, [field]: value }));
  return <>
    <section className="toolbar">
      <label className="sort-control">Sort<select aria-label="Sort receipts" value={sortOrder} onChange={(e) => onSortChange(e.target.value)}>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
      </select></label>
      <button className="toolbar-link" onClick={onToggleFilters}>{showFilters ? 'Hide filters' : 'Filter receipts'}</button>
    </section>
    {showFilters && <section className="receipt-filters">
      <label>Category<select value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
        <option value="">All categories</option>
        {categories.map((category) => <option key={category} value={category}>{category}</option>)}
      </select></label>
      <label>From<input type="date" value={filters.startDate} onChange={(e) => setFilter('startDate', e.target.value)} /></label>
      <label>To<input type="date" value={filters.endDate} onChange={(e) => setFilter('endDate', e.target.value)} /></label>
      <label>Minimum<input inputMode="decimal" type="number" min="0" step="0.01" value={filters.minAmount} onChange={(e) => setFilter('minAmount', e.target.value)} placeholder="$0" /></label>
      <label>Maximum<input inputMode="decimal" type="number" min="0" step="0.01" value={filters.maxAmount} onChange={(e) => setFilter('maxAmount', e.target.value)} placeholder="Any amount" /></label>
      <button className="clear-filters" onClick={() => onFiltersChange(EMPTY_FILTERS)}>Clear</button>
    </section>}
    {filtered.length === 0 && <div className="empty">
      <h2>No receipts here yet.</h2>
      <p>Text a receipt photo to Slip and it will appear in this inbox.</p>
    </div>}
    <div className="receipt-list">{filtered.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} onSelect={onSelect} />)}</div>
    <div className="list-footer">
      <span className="count">{countLabel(filtered.length, 'receipt')} loaded</span>
      {hasMore && <button className="load-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
    </div>
  </>;
}
