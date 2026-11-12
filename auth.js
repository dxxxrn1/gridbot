// auth.js
// Role-based session authentication for GridBot Main App (Owner & Staff roles).

const crypto = require('crypto');
require('dotenv').config();

const OWNER_PASSCODE = String(process.env.OWNER_PASSCODE || '').trim();
const STAFF_PASSCODE = String(process.env.STAFF_PASSCODE || '').trim();

if (!OWNER_PASSCODE || OWNER_PASSCODE.length < 6) {
  throw new Error('[Auth] Startup refused: OWNER_PASSCODE must be set in .env and at least 6 characters long.');
}
if (!STAFF_PASSCODE || STAFF_PASSCODE.length < 6) {
  throw new Error('[Auth] Startup refused: STAFF_PASSCODE must be set in .env and at least 6 characters long.');
}

function getOwnerPasscodes() {
  return { primary: OWNER_PASSCODE, valid: new Set([OWNER_PASSCODE]) };
}

function getStaffPasscodes() {
  return { primary: STAFF_PASSCODE, valid: new Set([STAFF_PASSCODE]) };
}

// Active session store: token -> { token, username, displayName, role, loginAt }
const sessions = new Map();

const { verifyStaffCredentials } = require('./policy-client');

/**
 * Validates credentials (by username + password OR role + passcode) and creates a session token.
 * Supports both `login(username, password)` and `login({ username, password, role, passcode })`.
 */
async function login(usernameOrPayload, maybePassword) {
  let username = '';
  let password = '';
  let roleHint = '';

  if (usernameOrPayload && typeof usernameOrPayload === 'object') {
    username = String(usernameOrPayload.username || usernameOrPayload.role || '').trim().toLowerCase();
    password = String(
      usernameOrPayload.password ?? usernameOrPayload.passcode ?? ''
    ).trim();
    roleHint = String(usernameOrPayload.role || '').trim().toLowerCase();
  } else {
    username = String(usernameOrPayload || '').trim().toLowerCase();
    password = String(maybePassword || '').trim();
  }

  let matchedUser = null;

  // 1. Try dynamic verification via Policy Service (Supabase / local DB)
  try {
    const verified = await verifyStaffCredentials(username, password);
    if (verified && verified.ok && verified.user) {
      matchedUser = verified.user;
    }
  } catch (_) {}

  // 2. Fall back to environment / hardcoded presets
  if (!matchedUser) {
    const ownerAuth = getOwnerPasscodes();
    const staffAuth = getStaffPasscodes();

    const isOwnerUser =
      roleHint === 'owner' || username === 'owner' || username === 'admin';
    const isStaffUser =
      roleHint === 'staff' || username === 'thabo' || username === 'staff';

    if (isOwnerUser && ownerAuth.valid.has(password)) {
      matchedUser = {
        username: username === 'admin' ? 'admin' : 'owner',
        displayName: 'Cafe Owner (Admin)',
        role: 'owner',
      };
    } else if (isStaffUser && staffAuth.valid.has(password)) {
      matchedUser = {
        username: username === 'staff' ? 'staff' : 'thabo',
        displayName: 'Thabo (Shift Cashier)',
        role: 'staff',
      };
    }
  }

  if (!matchedUser) {
    return {
      ok: false,
      error: 'Invalid credentials. Check your username and passcode.',
    };
  }

  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    token,
    username: matchedUser.username,
    displayName: matchedUser.displayName,
    role: matchedUser.role,
    shift: matchedUser.shift || 'Shift Member',
    loginAt: new Date().toISOString(),
  };

  sessions.set(token, session);

  return {
    ok: true,
    token,
    user: {
      username: session.username,
      displayName: session.displayName,
      role: session.role,
      shift: session.shift,
    },
  };
}

/**
 * Removes an active session token.
 */
function logout(tokenOrReq) {
  let token = '';
  if (typeof tokenOrReq === 'string') {
    token = tokenOrReq.trim();
  } else if (tokenOrReq && tokenOrReq.headers) {
    token = String(tokenOrReq.headers['x-session-token'] || '').trim();
  }
  if (token && sessions.has(token)) {
    sessions.delete(token);
    return true;
  }
  return false;
}

/**
 * Reads `req.headers['x-session-token']` (or `Authorization: Bearer <token>`)
 * or falls back to checking `req.headers['x-owner-passcode']` against OWNER_PASSCODE
 * as an implicit owner session so existing scripts keep working.
 */
function getUserFromReq(req) {
  if (!req || !req.headers) return null;

  const headerToken = String(req.headers['x-session-token'] || '').trim();
  const bearerMatch = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  const token = headerToken || (bearerMatch ? bearerMatch[1].trim() : '');

  if (token && sessions.has(token)) {
    const s = sessions.get(token);
    return {
      username: s.username,
      displayName: s.displayName,
      role: s.role,
      token: s.token,
    };
  }

  const passcodeHeader = String(req.headers['x-owner-passcode'] || '').trim();
  if (passcodeHeader) {
    const ownerAuth = getOwnerPasscodes();
    if (ownerAuth.valid.has(passcodeHeader)) {
      return {
        username: 'owner',
        displayName: 'Cafe Owner (Admin)',
        role: 'owner',
        viaPasscode: true,
      };
    }
  }

  return null;
}

/**
 * Express middleware: requires a valid `staff` or `owner` session.
 */
function requireAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Authentication required. Please log in as Staff or Owner.',
    });
  }
  req.user = user;
  next();
}

/**
 * Express middleware: requires `role === 'owner'` (or valid `x-owner-passcode`).
 * Does NOT inject or store the owner passcode server-side; the browser must send `x-owner-passcode` per request.
 */
function requireOwner(req, res, next) {
  const user = getUserFromReq(req);
  const rawPasscode = String(req.headers['x-owner-passcode'] || '').trim();
  const ownerAuth = getOwnerPasscodes();

  if (user && user.role === 'owner') {
    req.user = user;
    return next();
  }

  if (rawPasscode && ownerAuth.valid.has(rawPasscode)) {
    req.user = {
      username: 'owner',
      displayName: 'Cafe Owner (Admin)',
      role: 'owner',
      viaPasscode: true,
    };
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: 'Unauthorized: Owner authentication or valid x-owner-passcode required.',
  });
}

module.exports = {
  login,
  logout,
  getUserFromReq,
  requireAuth,
  requireOwner,
};
