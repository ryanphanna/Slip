import { useMemo, useState } from 'react';
import ItemDetail from '../components/ItemDetail.jsx';
import { call } from '../firebase.js';
import { formatListDate, formatMoney, hasDistinctPublicName } from '../format.js';

export default function ItemsView({ receipts, catalogItems, onReceiptUpdated, search }) {
  const [mode, setMode] = useState('verified');
  const [selectedItem, setSelectedItem] = useState(null);
  const items = useMemo(() => (catalogItems.length > 0 ? catalogItems : receipts.flatMap((receipt) => (receipt.items || []).map((item, index) => ({
    ...item,
    id: `${receipt.id}-${index}`,
    receiptId: receipt.id,
    index,
    merchant: receipt.merchant || 'Unknown merchant',
    date: receipt.date || 'No date',
  })))), [catalogItems, receipts]);
  const visibleItems = items.filter((item) => mode === 'verified' ? item.verified === true : item.verified !== true);
  const filtered = visibleItems.filter((item) => `${item.name} ${item.publicName || ''} ${item.category} ${item.merchant}`.toLowerCase().includes(search.toLowerCase()));

  async function verifyItem(item) {
    if (item.id && !item.receiptId) {
      await call('updateItem', { id: item.id, patch: { verified: true } });
      onReceiptUpdated(null);
      return;
    }
    const receipt = receipts.find((candidate) => candidate.id === item.receiptId);
    if (!receipt) return;
    const updated = await call('updateReceipt', { id: receipt.id, patch: { items: receipt.items.map((current, index) => index === item.index ? { ...current, verified: true } : current) } });
    onReceiptUpdated(updated);
  }

  return <section className="items-page">
    <div className="item-tabs">
      <button className={mode === 'verified' ? 'active' : 'secondary'} onClick={() => setMode('verified')}>Verified</button>
      <button className={mode === 'review' ? 'active' : 'secondary'} onClick={() => setMode('review')}>Needs review</button>
    </div>
    {filtered.length === 0 ? <div className="empty">
      <h2>{mode === 'verified' ? 'No verified items yet.' : 'Nothing needs review.'}</h2>
      <p>{mode === 'verified' ? 'Approve items from the Needs review tab before they appear here.' : 'Newly captured items will appear here for approval.'}</p>
    </div> : <>
      <div className="item-list">
        {filtered.map((item) => <div className="catalog-item" key={item.id} onClick={() => setSelectedItem(item)}>
          <div>
            <strong>{item.publicName || item.name || 'Unnamed item'}</strong>
            <small>{[hasDistinctPublicName(item) ? item.name : '', item.merchant, item.date && formatListDate(item.date), item.category].filter(Boolean).join(' · ')}</small>
          </div>
          <span className="item-action">
            <span>×{item.quantity || 1}</span>
            <strong>{formatMoney(item.price)}</strong>
            {mode === 'review' && <button onClick={(e) => { e.stopPropagation(); verifyItem(item); }}>Approve</button>}
          </span>
        </div>)}
      </div>
      <div className="list-footer"><span className="count">{filtered.length} items</span></div>
    </>}
    {selectedItem && <ItemDetail item={selectedItem} onClose={() => setSelectedItem(null)} />}
  </section>;
}
