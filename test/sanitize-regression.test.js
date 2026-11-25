import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, REDACTED, MAX_DIAGNOSTIC_INPUT_LENGTH } from '../src/sanitize.js';

// All credential-like strings below are deliberately artificial.
test('redaction: whole quoted credentials and authorization values', () => {
  const cases = [
    `api_key='fake-example-value'`,
    `{'password':'fake-example-value'}`,
    `password="fake example value"`,
    `apiToken: 'fake example value'`,
    `APMIX_API_KEY='fake-example-value'`,
    `"Authorization":"Bearer fake-example-value"`,
    `'Authorization': 'Basic fake-example-value'`,
    `Authorization: Bearer fake-example-value`,
    `password="fake example value`,
    `password='fake example value`,
  ];
  for (const input of cases) {
    const output = redactSecrets(input);
    assert.ok(output.includes(REDACTED), 'expected a redaction marker');
    assert.ok(!output.includes('fake'), 'no credential fragment may survive');
    assert.ok(!output.includes('example'), 'no quoted suffix may survive');
  }
});

test('redaction: escaped quotes and multiple credentials', () => {
  const input = String.raw`password="fake \"example\" value"; token='fake-second'`;
  const output = redactSecrets(input);
  assert.ok(!output.includes('fake'));
  assert.ok(!output.includes('example'));
  assert.ok(!output.includes('value'));
});

test('redaction: oversized data is omitted, not partially returned', () => {
  const input = 'x'.repeat(MAX_DIAGNOSTIC_INPUT_LENGTH) + ' password=fake-secret';
  const output = redactSecrets(input);
  assert.ok(output.includes(REDACTED));
  assert.ok(output.length < 100);
  assert.ok(!output.includes('fake-secret'));
});

test('redaction: harmless text and non-string values', () => {
  assert.equal(redactSecrets('EACCES: permission denied'), 'EACCES: permission denied');
  for (const input of [null, undefined, 42, {}, Symbol('fake')]) {
    assert.equal(redactSecrets(input), '');
  }
});
