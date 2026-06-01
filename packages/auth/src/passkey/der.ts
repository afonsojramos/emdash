/**
 * Minimal ASN.1 DER for the two WebAuthn key algorithms.
 *
 * - RSA public keys are stored as SubjectPublicKeyInfo (SPKI) so they import
 *   directly into WebCrypto and match the format previously produced by
 *   `@oslojs/crypto`'s `RSAPublicKey.encodePKIX()`.
 * - ECDSA assertion signatures arrive as a DER-encoded `Ecdsa-Sig-Value`
 *   sequence, but `crypto.subtle.verify` wants the raw `r || s` form. This is
 *   the single most common WebAuthn-on-WebCrypto footgun.
 */

export class DerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DerError";
	}
}

// rsaEncryption: OBJECT IDENTIFIER 1.2.840.113549.1.1.1
const RSA_ENCRYPTION_OID = new Uint8Array([
	0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
]);
const ASN1_NULL = new Uint8Array([0x05, 0x00]);

const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_SEQUENCE = 0x30;

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function encodeLength(length: number): Uint8Array {
	if (length < 0x80) return new Uint8Array([length]);
	const bytes: number[] = [];
	let n = length;
	while (n > 0) {
		bytes.unshift(n & 0xff);
		n >>= 8;
	}
	return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
	return concat([new Uint8Array([tag]), encodeLength(content.length), content]);
}

/** Encode an unsigned big-endian integer as a DER INTEGER (positive, minimal). */
function encodeUint(bytes: Uint8Array): Uint8Array {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start++;
	let body = bytes.subarray(start);
	if (body.length === 0) body = new Uint8Array([0]);
	// Prepend 0x00 when the high bit is set so the value stays positive.
	if ((body[0]! & 0x80) !== 0) {
		body = concat([new Uint8Array([0]), body]);
	}
	return tlv(TAG_INTEGER, body);
}

/** Build a SubjectPublicKeyInfo for an RSA public key from COSE (n, e) bytes. */
export function encodeRsaSpki(modulus: Uint8Array, exponent: Uint8Array): Uint8Array {
	const rsaPublicKey = tlv(TAG_SEQUENCE, concat([encodeUint(modulus), encodeUint(exponent)]));
	const algorithm = tlv(TAG_SEQUENCE, concat([RSA_ENCRYPTION_OID, ASN1_NULL]));
	const subjectPublicKey = tlv(TAG_BIT_STRING, concat([new Uint8Array([0x00]), rsaPublicKey]));
	return tlv(TAG_SEQUENCE, concat([algorithm, subjectPublicKey]));
}

/**
 * Convert a DER `Ecdsa-Sig-Value` (SEQUENCE { INTEGER r, INTEGER s }) into the
 * fixed-width `r || s` form WebCrypto expects. `size` is the coordinate width
 * in bytes (32 for P-256).
 */
export function ecdsaDerToRaw(der: Uint8Array, size: number): Uint8Array {
	let offset = 0;

	const readByte = (): number => {
		if (offset >= der.length) throw new DerError("unexpected end of DER signature");
		return der[offset++]!;
	};

	const readLength = (): number => {
		const first = readByte();
		if (first < 0x80) return first;
		const count = first & 0x7f;
		// Lengths here are tiny (two ~32-byte integers); reject long forms.
		if (count !== 1) throw new DerError("unsupported DER length");
		return readByte();
	};

	const readInteger = (): Uint8Array => {
		if (readByte() !== TAG_INTEGER) throw new DerError("expected DER INTEGER");
		const length = readLength();
		if (length === 0 || length > der.length - offset) {
			throw new DerError("invalid DER INTEGER length");
		}
		const value = der.subarray(offset, offset + length);
		offset += length;
		// Strip the single leading 0x00 used to keep the value positive.
		let start = 0;
		while (start < value.length - 1 && value[start] === 0) start++;
		const trimmed = value.subarray(start);
		if (trimmed.length > size) throw new DerError("DER integer wider than coordinate size");
		const padded = new Uint8Array(size);
		padded.set(trimmed, size - trimmed.length);
		return padded;
	};

	if (readByte() !== TAG_SEQUENCE) throw new DerError("expected DER SEQUENCE");
	const seqLength = readLength();
	if (seqLength !== der.length - offset) throw new DerError("DER sequence length mismatch");

	const r = readInteger();
	const s = readInteger();
	if (offset !== der.length) throw new DerError("unexpected trailing bytes in DER signature");

	return concat([r, s]);
}
