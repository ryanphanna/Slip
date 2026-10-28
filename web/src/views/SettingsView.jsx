import { useState } from 'react';
import ImportTokens from '../components/ImportTokens.jsx';

export default function SettingsView({ settings, onDigestChange }) {
  const [status, setStatus] = useState('');
  async function toggle(event) {
    setStatus('Saving…');
    try {
      await onDigestChange(event.target.checked);
      setStatus('Saved.');
    } catch (error) {
      setStatus(error.message || 'Could not save settings.');
    }
  }
  return <section className="settings-page card-stack">
    <div className="card settings-section">
      <label className="setting-row">
        <span>
          <strong>Monthly recap</strong>
          <small>Get a text at the start of each month with your previous month’s spending.</small>
        </span>
        <input className="setting-toggle" type="checkbox" checked={settings.monthlyDigestEnabled !== false} onChange={toggle} />
      </label>
    </div>
    {status && <p className="status">{status}</p>}
    <ImportTokens />
  </section>;
}
