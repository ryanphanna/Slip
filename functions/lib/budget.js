const admin = require('firebase-admin');

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

  const spentMap = {};
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const cat = data.category || 'Other';
    const amount = data.total || 0;
    spentMap[cat.toLowerCase()] = (spentMap[cat.toLowerCase()] || 0) + amount;
  }

  // Combine into status report
  const report = [];
  
  // 1. Add categories with budgets
  for (const b of budgets) {
    const catLower = b.category.toLowerCase();
    const spent = Math.round((spentMap[catLower] || 0) * 100) / 100;
    report.push({
      category: b.category,
      limit: b.limit,
      spent,
      remaining: Math.round((b.limit - spent) * 100) / 100,
      percentage: b.limit > 0 ? Math.round((spent / b.limit) * 100) : 0,
    });
  }

  // 2. Add categories that had spending but no budget (optional)
  for (const [catLower, spent] of Object.entries(spentMap)) {
    if (budgetMap[catLower] === undefined) {
      const originalCat = snapshot.docs.find(doc => doc.data().category?.toLowerCase() === catLower)?.data().category || 'Other';
      report.push({
        category: originalCat,
        limit: 0,
        spent: Math.round(spent * 100) / 100,
        remaining: Math.round(-spent * 100) / 100,
        percentage: 0,
      });
    }
  }

  return report;
}

module.exports = { setBudget, getBudget, getAllBudgets, getBudgetReport };
