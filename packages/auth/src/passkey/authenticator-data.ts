/**
 * Binary parsers for the WebAuthn authenticator data, attestation object, and
 * client data JSON.
 *
 * authenticatorData layout (WebAuthn L3 §6.1):
 *   rpIdHash (32) | flags (1) | signCount (4) |
 *   [attestedCredentialData if AT] | [extensions (CBOR map) if ED]
 *
 * Unlike a parser that stops after the public key, this consumes and validates
 * the extensions block when the ED flag is set and asserts the whole buffer is
 * consumed -- trailing bytes are a malformed input, not something to ignore.
 */

import { CborReader, decodeCbor } from "./cbor.js";
import type { CborMap } from "./cbor.js";

const MIN_AUTH_DATA_LENGTH = 37;
const AAGUID_LENGTH = 16;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export class WebAuthnDataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebAuthnDataError";
	}
}

export interface AuthenticatorDataFlags {
	userPresent: boolean;
	userVerified: boolean;
	backupEligible: boolean;
	backupState: boolean;
	attestedCredentialData: boolean;
	extensionData: boolean;
}

export interface AttestedCredential {
	id: Uint8Array;
	publicKey: CborMap;
}

export interface ParsedAuthenticatorData {
	rpIdHash: Uint8Array;
	flags: AuthenticatorDataFlags;
	signatureCounter: number;
	credential?: AttestedCredential;
}

export function parseAuthenticatorData(bytes: Uint8Array): ParsedAuthenticatorData {
	if (bytes.length < MIN_AUTH_DATA_LENGTH) {
		throw new WebAuthnDataError("authenticator data too short");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	const rpIdHash = bytes.slice(0, 32);
	const flagBits = bytes[32]!;
	const flags: AuthenticatorDataFlags = {
		userPresent: (flagBits & FLAG_UP) !== 0,
		userVerified: (flagBits & FLAG_UV) !== 0,
		backupEligible: (flagBits & FLAG_BE) !== 0,
		backupState: (flagBits & FLAG_BS) !== 0,
		attestedCredentialData: (flagBits & FLAG_AT) !== 0,
		extensionData: (flagBits & FLAG_ED) !== 0,
	};
	const signatureCounter = view.getUint32(33, false);

	let offset = MIN_AUTH_DATA_LENGTH;
	let credential: AttestedCredential | undefined;

	if (flags.attestedCredentialData) {
		if (bytes.length < offset + AAGUID_LENGTH + 2) {
			throw new WebAuthnDataError("truncated attested credential data");
		}
		offset += AAGUID_LENGTH; // aaguid is not used
		const credentialIdLength = view.getUint16(offset, false);
		offset += 2;
		if (bytes.length < offset + credentialIdLength) {
			throw new WebAuthnDataError("truncated credential id");
		}
		const id = bytes.slice(offset, offset + credentialIdLength);
		offset += credentialIdLength;

		const reader = new CborReader(bytes.subarray(offset));
		const publicKey = reader.read();
		if (!(publicKey instanceof Map)) {
			throw new WebAuthnDataError("credential public key is not a COSE map");
		}
		offset += reader.offset;
		credential = { id, publicKey };
	}

	if (flags.extensionData) {
		const reader = new CborReader(bytes.subarray(offset));
		const extensions = reader.read();
		if (!(extensions instanceof Map)) {
			throw new WebAuthnDataError("extension data is not a CBOR map");
		}
		offset += reader.offset;
	}

	if (offset !== bytes.length) {
		throw new WebAuthnDataError("unexpected trailing authenticator data");
	}

	return { rpIdHash, flags, signatureCounter, credential };
}

export interface ParsedAttestationObject {
	format: string;
	authenticatorData: ParsedAuthenticatorData;
}

export function parseAttestationObject(bytes: Uint8Array): ParsedAttestationObject {
	const decoded = decodeCbor(bytes);
	if (!(decoded instanceof Map)) {
		throw new WebAuthnDataError("attestation object is not a CBOR map");
	}
	const format = decoded.get("fmt");
	const authData = decoded.get("authData");
	if (typeof format !== "string") {
		throw new WebAuthnDataError("attestation object missing fmt");
	}
	if (!(authData instanceof Uint8Array)) {
		throw new WebAuthnDataError("attestation object missing authData");
	}
	return { format, authenticatorData: parseAuthenticatorData(authData) };
}

export interface ParsedClientData {
	type: string;
	challenge: string;
	origin: string;
}

export function parseClientDataJSON(bytes: Uint8Array): ParsedClientData {
	let parsed: unknown;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		parsed = JSON.parse(text);
	} catch {
		throw new WebAuthnDataError("client data is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new WebAuthnDataError("client data is not an object");
	}
	const type = "type" in parsed ? parsed.type : undefined;
	const challenge = "challenge" in parsed ? parsed.challenge : undefined;
	const origin = "origin" in parsed ? parsed.origin : undefined;
	if (typeof type !== "string" || typeof challenge !== "string" || typeof origin !== "string") {
		throw new WebAuthnDataError("client data missing required fields");
	}
	return { type, challenge, origin };
}
