/**
 * Signature and hash primitives via WebCrypto (`crypto.subtle`), replacing
 * `@oslojs/crypto`. Available on both Workers and Node, and actively maintained
 * as a platform primitive.
 */

import { COSE_ALG_ES256, COSE_ALG_RS256 } from "./cose-key.js";
import { ecdsaDerToRaw } from "./der.js";

const P256_COORDINATE_BYTES = 32;

/** Copy into a standalone ArrayBuffer; WebCrypto mishandles offset subarrays. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
	return new Uint8Array(bytes).buffer;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest("SHA-256", toBuffer(data));
	return new Uint8Array(digest);
}

export async function verifyRpIdHash(rpIdHash: Uint8Array, rpId: string): Promise<boolean> {
	const expected = await sha256(new TextEncoder().encode(rpId));
	if (rpIdHash.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= rpIdHash[i]! ^ expected[i]!;
	}
	return diff === 0;
}

export interface AssertionSignatureInput {
	algorithm: number;
	publicKey: Uint8Array;
	authenticatorData: Uint8Array;
	clientDataJSON: Uint8Array;
	signature: Uint8Array;
}

/**
 * Verify a passkey assertion signature over `authenticatorData || SHA256(clientDataJSON)`.
 * `subtle.verify` hashes the message itself, so we pass the concatenation and
 * let it apply SHA-256.
 */
export async function verifyAssertionSignature(input: AssertionSignatureInput): Promise<boolean> {
	const { algorithm, publicKey, authenticatorData, clientDataJSON, signature } = input;

	const clientDataHash = await sha256(clientDataJSON);
	const message = new Uint8Array(authenticatorData.length + clientDataHash.length);
	message.set(authenticatorData, 0);
	message.set(clientDataHash, authenticatorData.length);

	if (algorithm === COSE_ALG_ES256) {
		const key = await crypto.subtle.importKey(
			"raw",
			toBuffer(publicKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const rawSignature = ecdsaDerToRaw(signature, P256_COORDINATE_BYTES);
		return crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			toBuffer(rawSignature),
			toBuffer(message),
		);
	}

	if (algorithm === COSE_ALG_RS256) {
		const key = await crypto.subtle.importKey(
			"spki",
			toBuffer(publicKey),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		return crypto.subtle.verify(
			{ name: "RSASSA-PKCS1-v1_5" },
			key,
			toBuffer(signature),
			toBuffer(message),
		);
	}

	return false;
}
