import { useEffect, useState } from 'react';
import { call } from '../firebase.js';
import { amountOrNull, formatMoney, formatPurchaseDate, hasDistinctPublicName } from '../format.js';

const CURRENCIES = [
  ['CAD', 'Canadian dollar'],
  ['USD', 'US dollar'],
  ['EUR', 'Euro'],
  ['GBP', 'Pound sterling'],
  ['AUD', 'Australian dollar'],
  ['JPY', 'Japanese yen'],
];

const CATALOG_FIELDS = [
  ['publicName', 'Public name', 'Public name'],
  ['itemNumber', 'Item number', 'TCIN / item number'],
  ['upc', 'UPC', 'UPC'],
  ['dpci', 'DPCI', 'DPCI'],
  ['productUrl', 'Product URL', 'Product URL'],
];

export default function ReceiptDetail({ receipt, onClose, onSaved, categories = [] }) {
  const [draft, setDraft] = useState({ ...receipt, items: receipt.items || [] });
  const [editing, setEditing] = useState(false);
  const [images, setImages] = useState([]);
  const [zoomedImage, setZoomedImage] = useState(null);
  const [status, setStatus] = useState('');
  const [otherCategory, setOtherCategory] = useState(receipt.category ? !categories.includes(receipt.category) : false);
  const [expandedItems, setExpandedItems] = useState(() => new Set());

  useEffect(() => {
    setDraft({ ...receipt, items: receipt.items || [] });
    setEditing(false);
    setStatus('');
    setOtherCategory(receipt.category ? !categories.includes(receipt.category) : false);
    setExpandedItems(new Set());
    call('getReceiptImageUrls', { id: receipt.id }).then(({ urls }) => setImages(urls)).catch(() => setStatus('The receipt image could not be loaded.'));
  }, [receipt.id]);

  function toggleItemCatalog(index) {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const updateItem = (index, field, value) => update('items', draft.items.map((current, i) => i === index ? { ...current, [field]: value } : current));

  function changeCategory(value) {
    if (value === '__other__') {
      setOtherCategory(true);
      update('category', '');
    } else {
      setOtherCategory(false);
      update('category', value);
    }
  }

  async function save(event) {
    event.preventDefault();
    setStatus('Saving…');
    try {
      const result = await call('updateReceipt', { id: receipt.id, patch: {
        merchant: draft.merchant, location: draft.location, date: draft.date,
        total: amountOrNull(draft.total), subtotal: amountOrNull(draft.subtotal), tax: amountOrNull(draft.tax),
        category: draft.category, subCategory: draft.subCategory, currency: draft.currency, items: draft.items,
      } });
      setStatus('Saved.');
      onSaved(result);
    } catch (error) { setStatus(error.message || 'Could not save.'); }
  }

  const editForm = <form onSubmit={save} className="detail-form">
    <div className="field-grid">
      <label>Merchant<input value={draft.merchant || ''} onChange={(e) => update('merchant', e.target.value)} /></label>
      <label>Date<input type="date" value={draft.date || ''} onChange={(e) => update('date', e.target.value)} /></label>
      <label>Total<input type="number" step="0.01" value={draft.total ?? ''} onChange={(e) => update('total', e.target.value)} /></label>
      <label>Currency<select value={draft.currency || 'CAD'} onChange={(e) => update('currency', e.target.value)}>
        {draft.currency && !CURRENCIES.some(([code]) => code === draft.currency) && <option value={draft.currency}>{draft.currency}</option>}
        {CURRENCIES.map(([code, name]) => <option key={code} value={code}>{code} — {name}</option>)}
      </select></label>
      <label>Category<select value={otherCategory ? '__other__' : (draft.category || '')} onChange={(e) => changeCategory(e.target.value)}>
        <option value="">Select category</option>
        {categories.map((category) => <option key={category} value={category}>{category}</option>)}
        <option value="__other__">Other…</option>
      </select>{otherCategory && <input placeholder="New category" value={draft.category || ''} onChange={(e) => update('category', e.target.value)} />}</label>
    </div>
    <p className="meta">{receipt.type === 'refund' ? 'Refund' : 'Purchase'}</p>
    <h3>Items</h3>
    <div className="items">
      <div className="item-row item-row-header"><span>Item</span><span>Qty</span><span>Price</span></div>
      {draft.items.map((item, index) => {
        const expanded = expandedItems.has(index);
        return <div className="item-entry" key={`${receipt.id}-${index}`}>
          <div className="item-row">
            <input value={item.name} onChange={(e) => updateItem(index, 'name', e.target.value)} />
            <input aria-label={`Quantity for ${item.name}`} type="number" min="1" step="1" value={item.quantity ?? 1} onChange={(e) => updateItem(index, 'quantity', Number(e.target.value))} />
            <input aria-label={`Price for ${item.name}`} type="number" step="0.01" value={item.price ?? ''} onChange={(e) => updateItem(index, 'price', Number(e.target.value))} />
          </div>
          <button type="button" className="item-catalog-toggle" onClick={() => toggleItemCatalog(index)}>{expanded ? 'Hide catalog details' : 'Catalog details'}</button>
          {expanded && <div className="item-metadata">
            {CATALOG_FIELDS.map(([field, label, placeholder]) => <input key={field} aria-label={`${label} for ${item.name}`} placeholder={placeholder} value={item[field] || ''} onChange={(e) => updateItem(index, field, e.target.value)} />)}
          </div>}
        </div>;
      })}
    </div>
    <div className="actions">
      <button type="submit">Save corrections</button>
      <button type="button" className="secondary" onClick={() => setDraft({ ...receipt, items: receipt.items || [] })}>Reset</button>
    </div>
    {status && <p className="status">{status}</p>}
  </form>;

  const readOnly = <div className="detail-form read-only-detail">
    <div className="summary-grid">
      <div><small>Purchased</small><strong>{formatPurchaseDate(receipt.date)}</strong></div>
      <div><small>Category</small><strong>{receipt.category || 'Other'}</strong></div>
      <div><small>Items</small><strong>{(receipt.items || []).length}</strong></div>
      <div><small>Type</small><strong>{receipt.type === 'refund' ? 'Refund' : 'Purchase'}</strong></div>
    </div>
    <div className="read-only-items">
      {(receipt.items || []).map((item, index) => <div className="read-only-item" key={`${item.name}-${index}`}>
        <span><strong>{item.publicName || item.name || 'Unnamed item'}</strong>{hasDistinctPublicName(item) && <small>{item.name}</small>}</span>
        <span>×{item.quantity || 1}</span>
        <strong>{formatMoney(item.price, receipt.currency)}</strong>
      </div>)}
    </div>
    <div className="receipt-totals">
      <div><span>Subtotal</span><strong>{formatMoney(receipt.subtotal, receipt.currency)}</strong></div>
      <div><span>Tax</span><strong>{formatMoney(receipt.tax, receipt.currency)}</strong></div>
      <div className="receipt-total"><span>Total</span><strong>{formatMoney(receipt.total, receipt.currency)}</strong></div>
    </div>
  </div>;

  return <aside className="detail-panel">
    <div className="detail-header">
      <div><p className="eyebrow">Receipt</p><h2>{receipt.merchant || 'Unknown merchant'}</h2></div>
      <div className="detail-actions">
        <button className="edit-button" onClick={() => setEditing((value) => !value)}>{editing ? 'Done' : 'Edit'}</button>
        <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
      </div>
    </div>
    <div className="detail-body">
      <div className="detail-media">
        {images.length > 0 && <div className="image-strip">
          {images.map((url) => <button className="image-button" key={url} onClick={() => setZoomedImage(url)}><img src={url} alt="Original receipt; click to enlarge" /></button>)}
        </div>}
      </div>
      {editing ? editForm : readOnly}
    </div>
    {zoomedImage && <div className="image-modal" role="dialog" aria-label="Expanded receipt image" onClick={() => setZoomedImage(null)}>
      <button className="image-modal-close" aria-label="Close expanded image" onClick={() => setZoomedImage(null)}>×</button>
      <img src={zoomedImage} alt="Expanded original receipt" onClick={(event) => event.stopPropagation()} />
    </div>}
  </aside>;
}
