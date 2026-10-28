import { formatListDate, formatMoney } from '../format.js';

export default function ReceiptRow({ receipt, onSelect }) {
  return <button className="receipt-row" onClick={() => onSelect(receipt)}>
    <span className="receipt-date">{formatListDate(receipt.date)}</span>
    <span className="receipt-name">{receipt.merchant || 'Unknown merchant'}<small>{receipt.category || 'Other'} · {receipt.items?.length || 0} items</small></span>
    <strong className={receipt.type === 'refund' ? 'refund' : ''}>{formatMoney(receipt.total, receipt.currency)}</strong>
  </button>;
}
