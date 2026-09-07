import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SessionSecretTracker } from '../../src/security/secrets.js';

describe('Secret Containment & Redaction Pipeline', () => {
  it('registers and redacts secrets in session context', () => {
    const sessionId = 'test-session-1';
    const secret = 'SuperSecretToken_12345';

    SessionSecretTracker.registerSecretValue(sessionId, secret);

    const logOutput = `User executed action with token ${secret} successfully.`;
    const redacted = SessionSecretTracker.redact(sessionId, logOutput);

    assert.strictEqual(redacted.includes(secret), false, 'Raw secret must not appear in output');
    assert.strictEqual(redacted, 'User executed action with token [REDACTED] successfully.');
  });

  it('redacts across all sessions with redactAll', () => {
    const session1 = 'session-alpha';
    const session2 = 'session-beta';
    const secret1 = 'PassKey_Alpha_9876';
    const secret2 = 'PassKey_Beta_5432';

    SessionSecretTracker.registerSecretValue(session1, secret1);
    SessionSecretTracker.registerSecretValue(session2, secret2);

    const errorMessage = `Failed connecting to db with ${secret1} and secondary ${secret2}`;
    const scrubbed = SessionSecretTracker.redactAll(errorMessage);

    assert.strictEqual(scrubbed.includes(secret1), false);
    assert.strictEqual(scrubbed.includes(secret2), false);
    assert.strictEqual(scrubbed, 'Failed connecting to db with [REDACTED] and secondary [REDACTED]');
  });

  it('does not redact trivial strings shorter than 3 characters', () => {
    const session = 'session-short';
    SessionSecretTracker.registerSecretValue(session, 'ab');

    const sampleText = 'About abstract absolute ab normal';
    const result = SessionSecretTracker.redact(session, sampleText);
    assert.strictEqual(result, sampleText, 'Short strings (<3) should not trigger false positive replacement');
  });

  it('clears session secrets on cleanup', () => {
    const session = 'session-ephemeral';
    const secret = 'EphemeralSecret_XYZ';

    SessionSecretTracker.registerSecretValue(session, secret);
    SessionSecretTracker.clearSession(session);

    const sample = `Secret was ${secret}`;
    const result = SessionSecretTracker.redact(session, sample);
    assert.strictEqual(result, sample, 'Cleared session secrets must no longer redact');
  });
});
