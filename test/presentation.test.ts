import assert from 'node:assert/strict';
import test from 'node:test';
import { openAttachments, presentMessage } from '../src/presentation.js';

test('attachment guidance says how long the broker keeps files and how to keep them longer', () => {
  const message = {
    id: '00000000-0000-4000-8000-000000000001',
    from: 'lando',
    to: 'vader',
    room_id: null,
    priority: 'info' as const,
    attachments: [{ filename: 'after.png' }],
  };
  const guidance = presentMessage(message, 30).guidance.map((line) => line.text);
  assert.ok(guidance.includes(openAttachments(30)));
  assert.match(openAttachments(30), /keeps them 30 days after the last message that uses them/);
  assert.match(openAttachments(1), /keeps them 1 day after/);
  assert.match(openAttachments(30), /save_to.*Dropbox/);
  // Without a known retention the guidance makes no claim about it.
  assert.doesNotMatch(openAttachments(), /keeps them/);
});
