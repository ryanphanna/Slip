import { formatMoney, formatPurchaseDate, hasDistinctPublicName } from '../format.js';

export default function ItemDetail({ item, onClose }) {
  return <>
    <div className="detail-backdrop" onClick={onClose} />
    <aside className="detail-panel item-detail-panel">
      <div className="detail-header">
        <div><p className="eyebrow">Item</p><h2>{item.publicName || item.name || 'Unnamed item'}</h2></div>
        <div className="detail-actions"><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
      </div>
      {hasDistinctPublicName(item) && <p className="muted">{item.name}</p>}
      <div className="summary-grid">
        <div><small>Price</small><strong>{formatMoney(item.price, item.currency)}</strong></div>
        <div><small>Quantity</small><strong>×{item.quantity || 1}</strong></div>
        <div><small>Category</small><strong>{item.category || 'Other'}</strong></div>
        <div><small>Merchant</small><strong>{item.merchant || 'Unknown merchant'}</strong></div>
        <div><small>Date</small><strong>{formatPurchaseDate(item.date)}</strong></div>
        <div><small>Status</small><strong>{item.verified ? 'Verified' : 'Needs review'}</strong></div>
      </div>
      {(item.itemNumber || item.upc || item.dpci || item.productUrl) && <div className="summary-grid">
        {item.itemNumber && <div><small>TCIN / item number</small><strong>{item.itemNumber}</strong></div>}
        {item.upc && <div><small>UPC</small><strong>{item.upc}</strong></div>}
        {item.dpci && <div><small>DPCI</small><strong>{item.dpci}</strong></div>}
        {item.productUrl && <div><small>Product page</small><strong><a href={item.productUrl} target="_blank" rel="noreferrer">View product ↗</a></strong></div>}
      </div>}
    </aside>
  </>;
}
