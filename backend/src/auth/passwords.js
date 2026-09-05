// src/auth/passwords.js
//
// bcrypt via bcryptjs (pure-JS) rather than native bcrypt: Render's ephemeral
// build/free instance environment makes native bindings a real failure point,
// and bcryptjs is API-compatible. Cost 10 is the standard default — strong
// enough for this threat model (not a bank, but not trivially crackable either).

const bcrypt = require('bcryptjs');

const BCRYPT_COST = 10;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

module.exports = { hashPassword, verifyPassword };