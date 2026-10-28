import { useEffect, useState } from 'react';
import { call } from '../firebase.js';
import { formatFailureDate } from '../format.js';

export default function FailureRow({ failure, onRetry }) {
  const [image, setImage] = useState(null);
  useEffect(() => {
    call('getProcessingFailureImageUrls', { id: failure.id }).then(({ urls }) => setImage(urls?.[0] || null)).catch(() => {});
  }, [failure.id]);
  return <div className="failure-row">
    <span className="failure-info">
      {image ? <img src={image} alt="Receipt awaiting processing" /> : <span className="failure-placeholder">Receipt</span>}
      <span>
        <strong>{formatFailureDate(failure.createdAt, failure.numMedia)}</strong>
        <small>Slip couldn’t read this receipt.</small>
      </span>
    </span>
    <button onClick={() => onRetry(failure.id)}>Retry</button>
  </div>;
}
