const admin = require('firebase-admin');
const { aggregateSpendingByCategory } = require('./query');

function getDocId(from, category) {
  const safeFrom = (from || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
  const safeCategory = (category || 'Other').toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
  return `${safeFrom}_${safeCategory}`;
}

async function setBudget(from, category, limit) {
  const db = admin.firestore();
  const docId = getDocId(from, category);
  const cleanCategory = (category || 'Other').trim();
  const cleanLimit = Math.max(0, Number(limit) || 0);

  await db.collection('budgets').doc(docId).set({
    from: from.trim(),
    category: cleanCategory,
    limit: cleanLimit,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { category: cleanCategory, limit: cleanLimit };
}

async function getBudget(from, category) {
  const db = admin.firestore();
  const docId = getDocId(from, category);
  const doc = await db.collection('budgets').doc(docId).get();
  return doc.exists ? doc.data() : null;
}

async function getAllBudgets(from) {
  const db = admin.firestore();
  const snapshot = await db.collection('budgets')
    .where('from', '==', from)
    .get();
  return snapshot.docs.map(doc => doc.data());
}

async function getBudgetReport(from) {
  const db = admin.firestore();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Get all budgets
  const budgets = await getAllBudgets(from);
  const budgetMap = {};
  for (const b of budgets) {
    budgetMap[b.category.toLowerCase()] = b.limit;
  }

  // Get current month's receipts
  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .where('createdAt', '>=', startOfMonth)
    .get();

  const docs = snapshot.docs.map(doc => doc.data());
  const { categories: spentMap } = aggregateSpendingByCategory(docs);

  // Combine into status report
  const report = [];
  
  // 1. Add categories with budgets
  for (const b of budgets) {
    const catLower = b.category.toLowerCase();
    const spentKey = Object.keys(spentMap).find(k => k.toLowerCase() === catLower);
    const spent = spentKey ? spentMap[spentKey] : 0;
    report.push({
      category: b.category,
      limit: b.limit,
      spent,
      remaining: Math.round((b.limit - spent) * 100) / 100,
      percentage: b.limit > 0 ? Math.round((spent / b.limit) * 100) : 0,
    });
  }

  // 2. Add categories that had spending but no budget
  for (const [cat, spent] of Object.entries(spentMap)) {
    if (budgetMap[cat.toLowerCase()] === undefined) {
      report.push({
        category: cat,
        limit: 0,
        spent,
        remaining: Math.round(-spent * 100) / 100,
        percentage: 0,
      });
    }
  }

  return report;
}

module.exports = { setBudget, getBudget, getAllBudgets, getBudgetReport };
