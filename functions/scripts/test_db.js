const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'slip-c742b' });
admin.firestore().collection('receipts').orderBy('createdAt', 'desc').limit(5).get()
  .then(s => s.forEach(d => console.log(d.id, d.data().merchant, d.data().createdAt)))
  .catch(console.error);
