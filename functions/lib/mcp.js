const { authenticateToken } = require('./import-tokens');
const { importReceipt } = require('./import-receipt');
const { INPUT_SCHEMA } = require('./import-schema');

const MAX_BODY_BYTES = 64 * 1024;
const PROTOCOL_VERSION = '2025-03-26';

const TOOL = {
  name: 'create_receipt',
  description: 'Save one structured receipt to the Slip account this token belongs to. Read the receipt yourself and submit the fields; Slip does no image parsing on this path. Reuse the same idempotencyKey when retrying.',
  inputSchema: INPUT_SCHEMA,
};

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

function bearer(headers) {
  const value = headers?.authorization || headers?.Authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match ? match[1] : null;
}

// Stateless MCP over HTTP (JSON responses). Returns { status, body, headers? }.
async function handleMcp({ method, headers, body, rawLength }) {
  if (method !== 'POST') return { status: 405, headers: { Allow: 'POST' }, body: rpcError(null, -32000, 'Use POST') };
  if ((rawLength ?? JSON.stringify(body || '').length) > MAX_BODY_BYTES) {
    return { status: 413, body: rpcError(null, -32600, 'Request too large') };
  }

  const identity = await authenticateToken(bearer(headers));
  if (!identity) {
    return {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="slip"' },
      body: rpcError(null, -32001, 'Invalid or revoked token'),
    };
  }

  if (!body || Array.isArray(body) || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return { status: 400, body: rpcError(body?.id, -32600, 'Invalid JSON-RPC request') };
  }
  const { id, method: rpc, params } = body;

  if (id === undefined) return { status: 202, body: null }; // notification

  switch (rpc) {
    case 'initialize':
      return { status: 200, body: rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'slip', version: '1' } }) };
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: [TOOL] }) };
    case 'tools/call': {
      if (params?.name !== TOOL.name) return { status: 200, body: rpcError(id, -32602, 'Unknown tool') };
      try {
        const result = await importReceipt(identity, params.arguments);
        return { status: 200, body: rpcResult(id, { ...toolText(JSON.stringify(result)), structuredContent: result }) };
      } catch (err) {
        const known = ['invalid-argument', 'rate-limited', 'conflict'].includes(err.code);
        return { status: 200, body: rpcResult(id, toolText(known ? err.message : 'Could not save the receipt. Try again later.', true)) };
      }
    }
    default:
      return { status: 200, body: rpcError(id, -32601, 'Method not found') };
  }
}

module.exports = { handleMcp, MAX_BODY_BYTES, TOOL };
