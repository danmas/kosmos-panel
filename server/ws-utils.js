const { inventory } = require('./monitor');

function findServer(serverId) {
  return (inventory.servers || []).find((s) => s.id === serverId);
}

function resolvePrivateKey(credentialId) {
  const fs = require('fs');
  const cred = (inventory.credentials || []).find((c) => c.id === credentialId);
  if (!cred) throw new Error('credential not found');
  let key;
  try {
    if (cred.privateKeyPath) key = fs.readFileSync(cred.privateKeyPath, 'utf8');
  } catch (e) {
    // ignore; may use agent/password instead
  }
  let useAgent = cred.useAgent;
  if (typeof useAgent === 'string') useAgent = ['1', 'true', 'yes', 'on'].includes(useAgent.toLowerCase());
  return { key, passphrase: cred.passphrase || undefined, password: cred.password, useAgent: !!useAgent };
}

module.exports = { findServer, resolvePrivateKey };
