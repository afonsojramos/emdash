/**
 * COSE_Key (RFC 9052) interpretation for the two algorithms WebAuthn passkeys
 * use in practice: ES256 (ECDSA P-256) and RS256 (RSASSA-PKCS1-v1.5).
 *
 * Keys are encoded into the formats EmDash stores and WebCrypto imports:
 * - EC2 -> SEC1 uncompressed point (`0x04 || x || y`), imported as `raw`.
 * - RSA -> SubjectPublicKeyInfo (SPKI) DER, imported as `spki`.
 * These match what `@oslojs/crypto` produced, so stored credentials keep working.
 */

import type { CborMap, CborValue } from "./cbor.js";
import { encodeRsaSpki } from "./der.js";

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_RS256 = -257;

const KTY_EC2 = 2;
const KTY_RSA = 3;
const CRV_P256 = 1;

const LABEL_KTY = 1;
const LABEL_ALG = 3;
const LABEL_EC2_CRV = -1;
const LABEL_EC2_X = -2;
const LABEL_EC2_Y = -3;
const LABEL_RSA_N = -1;
const LABEL_RSA_E = -2;

const P256_COORDINATE_BYTES = 32;

export class CoseKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoseKeyError";
	}
}

export interface StoredPublicKey {
	algorithm: number;
	publicKey: Uint8Array;
}

function getInt(map: CborMap, label: number): number {
	const value = map.get(label);
	if (typeof value !== "number") {
		throw new CoseKeyError(`COSE key label ${label} must be an integer`);
	}
	return value;
}

function getBytes(map: CborMap, label: number): Uint8Array {
	const value: CborValue | undefined = map.get(label);
	if (!(value instanceof Uint8Array)) {
		throw new CoseKeyError(`COSE key label ${label} must be a byte string`);
	}
	return value;
}

/** Read the algorithm identifier without committing to a key type. */
export function coseKeyAlgorithm(map: CborMap): number {
	return getInt(map, LABEL_ALG);
}

/** Convert a parsed COSE key map into the stored public-key bytes. */
export function coseKeyToStored(map: CborMap): StoredPublicKey {
	const algorithm = coseKeyAlgorithm(map);
	const kty = getInt(map, LABEL_KTY);

	if (algorithm === COSE_ALG_ES256) {
		if (kty !== KTY_EC2) throw new CoseKeyError("ES256 requires an EC2 key");
		if (getInt(map, LABEL_EC2_CRV) !== CRV_P256) {
			throw new CoseKeyError("ES256 requires the P-256 curve");
		}
		const x = getBytes(map, LABEL_EC2_X);
		const y = getBytes(map, LABEL_EC2_Y);
		if (x.length !== P256_COORDINATE_BYTES || y.length !== P256_COORDINATE_BYTES) {
			throw new CoseKeyError("invalid P-256 coordinate length");
		}
		const publicKey = new Uint8Array(1 + x.length + y.length);
		publicKey[0] = 0x04;
		publicKey.set(x, 1);
		publicKey.set(y, 1 + x.length);
		return { algorithm, publicKey };
	}

	if (algorithm === COSE_ALG_RS256) {
		if (kty !== KTY_RSA) throw new CoseKeyError("RS256 requires an RSA key");
		const n = getBytes(map, LABEL_RSA_N);
		const e = getBytes(map, LABEL_RSA_E);
		return { algorithm, publicKey: encodeRsaSpki(n, e) };
	}

	throw new CoseKeyError(`unsupported COSE algorithm: ${algorithm}`);
}
