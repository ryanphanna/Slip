const admin = require('firebase-admin');

function findLatestReceiptForSender(snapshotDocs, from) {
  for (const doc of snapshotDocs) {
    if (doc.get('from') === from) return doc.data();
  }
  return null;
}

function aggregateSpendingByCategory(docs) {
  let total = 0;
  const categories = {};

  for (const d of docs) {
    if (d.total == null) continue;
    total += d.total;

    if (Array.isArray(d.items) && d.items.length > 0) {
      let sumItems = 0;
      for (const item of d.items) {
        const itemCat = item.category || d.category || 'Other';
        const itemPrice = item.price || 0;
        categories[itemCat] = (categories[itemCat] || 0) + itemPrice;
        sumItems += itemPrice;
      }
      // Allocate the difference (tax/tips/rounding) to the main category
      const diff = d.total - sumItems;
      if (Math.abs(diff) > 0.001) {
        const mainCat = d.category || 'Other';
        categories[mainCat] = (categories[mainCat] || 0) + diff;
      }
    } else {
      const cat = d.category || 'Other';
      categories[cat] = (categories[cat] || 0) + d.total;
    }
  }

  // Round values to 2 decimal places
  const roundedCategories = {};
  for (const [cat, amt] of Object.entries(categories)) {
    roundedCategories[cat] = Math.round(amt * 100) / 100;
  }

  return {
    total: Math.round(total * 100) / 100,
    categories: roundedCategories,
  };
}

async function getMonthlyStats(from) {
  const db = admin.firestore();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .where('createdAt', '>=', startOfMonth)
    .get();

  const docs = snapshot.docs.map(doc => doc.data());
  const { total, categories } = aggregateSpendingByCategory(docs);

  return { total, categories, count: docs.length, month: now.toLocaleString('default', { month: 'long' }) };
}

async function getSpendingStats(from, startDate) {
  const db = admin.firestore();
  let query = db.collection('receipts').where('from', '==', from);
  if (startDate) query = query.where('createdAt', '>=', startDate);
  const snapshot = await query.get();
  const docs = snapshot.docs.map(doc => doc.data());
  const { total, categories } = aggregateSpendingByCategory(docs);
  return { total, categories, count: docs.length };
}

async function getLastReceipt(from) {
  const db = admin.firestore();
  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0].data();
}

async function getLastMonthStats(from) {
  const db = admin.firestore();
  const now = new Date();
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .where('createdAt', '>=', startOfLastMonth)
    .where('createdAt', '<', startOfThisMonth)
    .get();

  const docs = snapshot.docs.map(doc => doc.data());
  const { total, categories } = aggregateSpendingByCategory(docs);
  const monthName = startOfLastMonth.toLocaleString('en-CA', { month: 'long' });

  return { total, categories, count: docs.length, month: monthName };
}

module.exports = { getMonthlyStats, getLastMonthStats, getSpendingStats, getLastReceipt, findLatestReceiptForSender, aggregateSpendingByCategory };
