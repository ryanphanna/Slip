// Minimal in-memory Firestore stand-in covering the query shapes actually
// used in lib/store.js and lib/web-api.js (where/orderBy/limit/startAfter
// chains, doc get/set, and collection add). Not a general Firestore emulator.

function getPath(data, field) {
  return field.split('.').reduce((v, k) => (v == null ? v : v[k]), data);
}

function toComparable(v) {
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return v;
}

function matches(data, field, op, value) {
  const actual = getPath(data, field);
  if (op === '==') return actual === value;
  const left = toComparable(actual);
  const right = toComparable(value);
  if (left == null) return false;
  if (op === '>=') return left >= right;
  if (op === '<=') return left <= right;
  throw new Error(`Unsupported operator in fake firestore: ${op}`);
}

function makeSnapshotDoc(id, data) {
  return {
    id,
    exists: true,
    data: () => ({ ...data }),
    get: (field) => getPath(data, field),
  };
}

class FakeQuery {
  constructor(collection, docs) {
    this.collection = collection;
    this.docs = docs;
  }
  where(field, op, value) {
    return new FakeQuery(this.collection, this.docs.filter((d) => matches(d.data, field, op, value)));
  }
  orderBy(field, direction = 'asc') {
    const sorted = [...this.docs].sort((a, b) => {
      const av = getPath(a.data, field);
      const bv = getPath(b.data, field);
      const cmp = av > bv ? 1 : av < bv ? -1 : 0;
      return direction === 'desc' ? -cmp : cmp;
    });
    return new FakeQuery(this.collection, sorted);
  }
  startAfter(cursorValue) {
    // Only supports the createdAt-Timestamp cursor pattern used in listReceipts.
    const cursorMillis = cursorValue?.toMillis?.() ?? cursorValue;
    return new FakeQuery(this.collection, this.docs.filter((d) => {
      const createdAt = d.data.createdAt;
      const millis = createdAt?.toMillis?.() ?? createdAt;
      return millis < cursorMillis;
    }));
  }
  limit(n) {
    return new FakeQuery(this.collection, this.docs.slice(0, n));
  }
  async get() {
    const docs = this.docs.map((d) => {
      const snap = makeSnapshotDoc(d.id, d.data);
      snap.ref = this.collection.doc(d.id);
      return snap;
    });
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeCollection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
    if (!store[name]) store[name] = new Map();
  }
  get _docs() {
    return [...this.store[this.name].entries()].map(([id, data]) => ({ id, data }));
  }
  where(...args) { return new FakeQuery(this, this._docs).where(...args); }
  orderBy(...args) { return new FakeQuery(this, this._docs).orderBy(...args); }
  limit(...args) { return new FakeQuery(this, this._docs).limit(...args); }
  doc(id) {
    if (id == null) id = `auto-${this.store.__nextId = (this.store.__nextId || 0) + 1}`;
    const map = this.store[this.name];
    return {
      id,
      get: async () => (map.has(id) ? makeSnapshotDoc(id, map.get(id)) : { exists: false, id, get: () => undefined, data: () => undefined }),
      set: async (data, opts = {}) => {
        const existing = opts.merge && map.has(id) ? map.get(id) : {};
        map.set(id, resolveSentinels({ ...existing, ...data }));
      },
    };
  }
  async add(data) {
    const id = `auto-${this.store.__nextId = (this.store.__nextId || 0) + 1}`;
    this.store[this.name].set(id, resolveSentinels(data));
    return this.doc(id);
  }
}

// Replace FieldValue.serverTimestamp() sentinels with a fixed fake Timestamp
// so tests can assert deterministic values.
function resolveSentinels(data) {
  const resolved = {};
  for (const [key, value] of Object.entries(data)) {
    resolved[key] = value === SERVER_TIMESTAMP_SENTINEL ? makeTimestamp(new Date()) : value;
  }
  return resolved;
}

const SERVER_TIMESTAMP_SENTINEL = Symbol('serverTimestamp');

function makeTimestamp(date) {
  return { toDate: () => date, toMillis: () => date.getTime() };
}

function createFakeFirestore() {
  const store = {};
  const db = {
    collection: (name) => new FakeCollection(store, name),
  };
  db.FieldValue = { serverTimestamp: () => SERVER_TIMESTAMP_SENTINEL };
  db.Timestamp = { fromMillis: (ms) => makeTimestamp(new Date(ms)) };
  return { db, store };
}

module.exports = { createFakeFirestore, makeTimestamp };
