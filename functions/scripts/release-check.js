#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hasIndex(indexes, fieldSpec) {
  return indexes.some(index =>
    Array.isArray(index.fields) &&
    index.fields.length === fieldSpec.length &&
    index.fields.every((field, i) =>
      field.fieldPath === fieldSpec[i].fieldPath &&
      field.order === fieldSpec[i].order
    )
  );
}

function main() {
  const functionsDir = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(functionsDir, '..');
  const packageJson = loadJson(path.join(functionsDir, 'package.json'));
  const firebaseJson = loadJson(path.join(repoRoot, 'firebase.json'));
  const indexesJson = loadJson(path.join(repoRoot, 'firestore.indexes.json'));

  const errors = [];
  const expectedRuntime = `nodejs${packageJson.engines.node}`;
  if (firebaseJson.functions.runtime !== expectedRuntime) {
    errors.push(`firebase.json runtime is ${firebaseJson.functions.runtime}, expected ${expectedRuntime}`);
  }

  const requiredIndexes = [
    [
      { fieldPath: 'from', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
    ],
    [
      { fieldPath: 'from', order: 'ASCENDING' },
      { fieldPath: 'merchant', order: 'ASCENDING' },
      { fieldPath: 'total', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
    ],
  ];

  for (const fieldSpec of requiredIndexes) {
    if (!hasIndex(indexesJson.indexes || [], fieldSpec)) {
      errors.push(`Missing Firestore index: ${fieldSpec.map(field => `${field.fieldPath}:${field.order}`).join(', ')}`);
    }
  }

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    runtime: firebaseJson.functions.runtime,
    requiredIndexesChecked: requiredIndexes.length,
  }, null, 2));
}

main();
