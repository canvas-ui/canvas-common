'use strict';

import { createHash, createPublicKey, sign, verify } from 'node:crypto';

/**
 * Hub-signed credentials: what a hub hands a runtime with every request it
 * forwards for a caller. An Ed25519 JWT (`alg: EdDSA`) whose claims name the
 * hub (`iss`), the runtime it is for (`aud`, the runtime's instanceId), the
 * resource (`res: { type, id }`) and the caller as the hub knows them
 * (`principal`, `binding`, `share`, `device`). No principal and no binding
 * means the resource owner.
 *
 * The runtime verifies the signature against the keys of the hubs it is
 * attached to, then applies its own ACL to the principal: the hub says who,
 * the runtime decides what.
 */

const CREDENTIAL_TYPE = 'canvas-hub+jwt';
// Clock skew tolerated between hub and runtime.
const SKEW_S = 30;
// The longest lifetime a runtime accepts, however the hub set `exp`.
const MAX_LIFETIME_S = 15 * 60;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** `kid` of a raw Ed25519 public key (base64url): the first 16 hex of its sha256. */
export function keyId(publicKey) {
    return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16);
}

/** True when a bearer value has the shape of a hub credential (three base64url parts). */
export function isHubCredential(value) {
    return typeof value === 'string' && /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(value);
}

/**
 * @param {Object} claims - `aud`, `res` and the caller fields; `iss`, `iat` and `exp` are set here
 * @param {{ iss: string, kid: string, privateKey: import('node:crypto').KeyObject }} key
 * @param {number} [lifetimeS=300]
 */
export function signHubCredential(claims, { iss, kid, privateKey }, lifetimeS = 300) {
    const iat = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'EdDSA', typ: CREDENTIAL_TYPE, kid })}.${b64({ ...claims, iss, iat, exp: iat + lifetimeS })}`;
    return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

/**
 * Verify a hub credential. Returns its claims, or null when it is malformed,
 * signed by no trusted key of its issuer, for another runtime, or expired.
 *
 * @param {string} value
 * @param {Object} options
 * @param {string} options.audience - this runtime's instanceId
 * @param {Array<{ iss: string, kid: string, key: string }>} options.keys - trusted hub keys (raw Ed25519, base64url)
 */
export function verifyHubCredential(value, { audience, keys }) {
    if (!isHubCredential(value) || !audience) return null;
    const [header64, claims64, signature64] = value.split('.');
    let header, claims;
    try {
        header = JSON.parse(Buffer.from(header64, 'base64url'));
        claims = JSON.parse(Buffer.from(claims64, 'base64url'));
    } catch { return null; }
    if (header?.alg !== 'EdDSA' || header.typ !== CREDENTIAL_TYPE || !claims || typeof claims !== 'object') return null;
    const trusted = (keys || []).find(k => k.iss === claims.iss && k.kid === header.kid);
    if (!trusted) return null;
    let publicKey;
    try { publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: trusted.key }, format: 'jwk' }); } catch { return null; }
    if (!verify(null, Buffer.from(`${header64}.${claims64}`), publicKey, Buffer.from(signature64, 'base64url'))) return null;
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== audience || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return null;
    if (claims.iat > now + SKEW_S || claims.exp < now - SKEW_S || claims.exp - claims.iat > MAX_LIFETIME_S) return null;
    if (typeof claims.res?.type !== 'string' || typeof claims.res?.id !== 'string') return null;
    return claims;
}
