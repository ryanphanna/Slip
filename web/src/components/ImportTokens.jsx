import { useEffect, useState } from 'react';
import { call } from '../firebase.js';

export default function ImportTokens() {
  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState('');
  const [newToken, setNewToken] = useState('');
  const [message, setMessage] = useState('');
  const mcpUrl = import.meta.env.VITE_MCP_URL || '';
  const refresh = () => call('listImportTokens').then((result) => setTokens(result.tokens)).catch(() => setMessage('Could not load tokens.'));
  useEffect(() => { refresh(); }, []);

  async function create() {
    setMessage('');
    try {
      const created = await call('createImportToken', { label });
      setNewToken(created.token);
      setLabel('');
      refresh();
    } catch (error) {
      setMessage(error.message || 'Could not create a token.');
    }
  }

  async function revoke(id) {
    try {
      await call('revokeImportToken', { id });
      refresh();
    } catch (error) {
      setMessage(error.message || 'Could not revoke the token.');
    }
  }

  return <div className="card settings-section import-tokens">
    <div className="setting-row">
      <span>
        <strong>Import with your own AI assistant</strong>
        <small>Connect an assistant that can read receipt photos. It can only add receipts to your account, never read them. Revoke access any time.</small>
      </span>
    </div>
    {mcpUrl && <p className="muted">Server address: <code>{mcpUrl}</code></p>}
    {newToken && <div className="new-token">
      <p><strong>Copy this token now. It won’t be shown again.</strong></p>
      <code>{newToken}</code> <button onClick={() => { navigator.clipboard?.writeText(newToken); }}>Copy</button> <button onClick={() => setNewToken('')}>Done</button>
    </div>}
    <div className="setting-row">
      <input aria-label="Token name" placeholder="Name, e.g. Claude" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
      <button onClick={create}>Create token</button>
    </div>
    {tokens.map((token) => <div className="setting-row" key={token.id}>
      <span>
        <strong>{token.label}</strong>
        <small>{token.revoked ? 'Revoked' : token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'Never used'}</small>
      </span>
      {!token.revoked && <button onClick={() => revoke(token.id)}>Revoke</button>}
    </div>)}
    {message && <p className="status">{message}</p>}
  </div>;
}
