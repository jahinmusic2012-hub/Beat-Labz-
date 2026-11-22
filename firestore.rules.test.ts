import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rules = fs.readFileSync('firestore.rules', 'utf8');

test('Firestore rules enforce rules_version 2 and default-deny safety net', () => {
  assert.match(rules, /rules_version\s*=\s*'2'/);
  assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
});

test('Firestore rules enforce email_verified, isValidId, size bounds, and request.time', () => {
  assert.match(rules, /request\.auth\.token\.email_verified\s*==\s*true/);
  assert.match(rules, /function isValidId\(id\)/);
  assert.match(rules, /request\.time/);
  assert.match(rules, /affectedKeys\(\)\.hasOnly/);
  assert.match(rules, /keys\(\)\.hasAll/);
  assert.match(rules, /keys\(\)\.hasOnly/);
});

test('Firestore rules do not contain blanket isSignedIn() list or read rules', () => {
  assert.doesNotMatch(rules, /allow\s+(read|list)\s*:\s*if\s*isSignedIn\(\)\s*;/);
});

test('Firestore rules isolate user PII under private/info and check Master Gate on subcollections', () => {
  assert.match(rules, /match \/private\/\{docId\}/);
  assert.match(rules, /exists\(\/databases\/\$\(database\)\/documents\/projects\/\$\(projectId\)\)/);
  assert.match(rules, /get\(\/databases\/\$\(database\)\/documents\/projects\/\$\(projectId\)\)/);
});
