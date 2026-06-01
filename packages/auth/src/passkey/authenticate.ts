/**
 * Passkey authentication (credential assertion)
 */

import { encodeBase64urlNoPadding, decodeBase64urlIgnorePadding } from "@oslojs/encoding";

import { generateToken } from "../tokens.js";
import type { Credential, AuthAdapter, User } from "../types.js";
import { parseAuthenticatorData, parseClientDataJSON } from "./authenticator-data.js";
import { COSE_ALG_ES256, COSE_ALG_RS256 } from "./cose-key.js";
import type {
	AuthenticationOptions,
	AuthenticationResponse,
	VerifiedAuthentication,
	ChallengeStore,
	PasskeyConfig,
} from "./types.js";
import { verifyAssertionSignature, verifyRpIdHash } from "./verify.js";

const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

export type PasskeyAuthenticationErrorCode =
	| "credential_not_found"
	| "invalid_response"
	| "challenge_not_found"
	| "invalid_challenge_type"
	| "challenge_expired"
	| "invalid_client_data_type"
	| "invalid_origin"
	| "invalid_rp_id_hash"
	| "user_presence_not_verified"
	| "invalid_signature_counter"
	| "invalid_signature"
	| "unsupported_algorithm"
	| "user_not_found";

export class PasskeyAuthenticationError extends Error {
	constructor(
		public code: PasskeyAuthenticationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "PasskeyAuthenticationError";
	}
}

function invalidPasskeyResponseError(): PasskeyAuthenticationError {
	return new PasskeyAuthenticationError("invalid_response", "Invalid passkey response");
}

function decodeAuthenticationResponse(response: AuthenticationResponse) {
	try {
		const clientDataJSON = decodeBase64urlIgnorePadding(response.response.clientDataJSON);
		const authenticatorData = decodeBase64urlIgnorePadding(response.response.authenticatorData);
		const signature = decodeBase64urlIgnorePadding(response.response.signature);
		const clientData = parseClientDataJSON(clientDataJSON);

		return { clientDataJSON, authenticatorData, signature, clientData };
	} catch {
		throw invalidPasskeyResponseError();
	}
}

function parseAuthenticationData(authenticatorData: Uint8Array) {
	try {
		return parseAuthenticatorData(authenticatorData);
	} catch {
		throw invalidPasskeyResponseError();
	}
}

/**
 * Generate authentication options for signing in with a passkey
 */
export async function generateAuthenticationOptions(
	config: PasskeyConfig,
	credentials: Credential[],
	challengeStore: ChallengeStore,
): Promise<AuthenticationOptions> {
	const challenge = generateToken();

	// Store challenge for verification
	await challengeStore.set(challenge, {
		type: "authentication",
		expiresAt: Date.now() + CHALLENGE_TTL,
	});

	return {
		challenge,
		rpId: config.rpId,
		timeout: 60000,
		userVerification: "preferred",
		allowCredentials:
			credentials.length > 0
				? credentials.map((cred) => ({
						type: "public-key" as const,
						id: cred.id,
						transports: cred.transports,
					}))
				: undefined, // Empty = allow any discoverable credential
	};
}

/**
 * Verify an authentication response
 */
export async function verifyAuthenticationResponse(
	config: PasskeyConfig,
	response: AuthenticationResponse,
	credential: Credential,
	challengeStore: ChallengeStore,
): Promise<VerifiedAuthentication> {
	const { clientDataJSON, authenticatorData, signature, clientData } =
		decodeAuthenticationResponse(response);

	// Verify client data type
	if (clientData.type !== "webauthn.get") {
		throw new PasskeyAuthenticationError("invalid_client_data_type", "Invalid client data type");
	}

	// Verify challenge - normalize to base64url no-padding to match the stored format
	const challengeString = encodeBase64urlNoPadding(
		decodeBase64urlIgnorePadding(clientData.challenge),
	);
	const challengeData = await challengeStore.get(challengeString);
	if (!challengeData) {
		throw new PasskeyAuthenticationError("challenge_not_found", "Challenge not found or expired");
	}
	if (challengeData.type !== "authentication") {
		throw new PasskeyAuthenticationError("invalid_challenge_type", "Invalid challenge type");
	}
	if (challengeData.expiresAt < Date.now()) {
		await challengeStore.delete(challengeString);
		throw new PasskeyAuthenticationError("challenge_expired", "Challenge expired");
	}

	// Delete challenge (single-use)
	await challengeStore.delete(challengeString);

	// Verify origin against the accepted list
	if (!config.origins.includes(clientData.origin)) {
		throw new PasskeyAuthenticationError(
			"invalid_origin",
			`Invalid origin: ${clientData.origin} not in [${config.origins.join(", ")}]`,
		);
	}

	// Parse authenticator data
	const authData = parseAuthenticationData(authenticatorData);

	// Verify RP ID hash
	if (!(await verifyRpIdHash(authData.rpIdHash, config.rpId))) {
		throw new PasskeyAuthenticationError("invalid_rp_id_hash", "Invalid RP ID hash");
	}

	// Verify flags
	if (!authData.flags.userPresent) {
		throw new PasskeyAuthenticationError(
			"user_presence_not_verified",
			"User presence not verified",
		);
	}

	// Verify counter (prevent replay attacks)
	if (authData.signatureCounter !== 0 && authData.signatureCounter <= credential.counter) {
		throw new PasskeyAuthenticationError(
			"invalid_signature_counter",
			"Invalid signature counter - possible cloned authenticator",
		);
	}

	if (credential.algorithm !== COSE_ALG_ES256 && credential.algorithm !== COSE_ALG_RS256) {
		throw new PasskeyAuthenticationError(
			"unsupported_algorithm",
			`Unsupported credential algorithm: ${credential.algorithm}`,
		);
	}

	// Ensure public key is a Uint8Array (may come as Buffer from some DB drivers)
	const publicKeyBytes =
		credential.publicKey instanceof Uint8Array
			? credential.publicKey
			: new Uint8Array(credential.publicKey);

	// A malformed signature or stored key surfaces as a failed verification, not a throw.
	let signatureValid: boolean;
	try {
		signatureValid = await verifyAssertionSignature({
			algorithm: credential.algorithm,
			publicKey: publicKeyBytes,
			authenticatorData,
			clientDataJSON,
			signature,
		});
	} catch {
		signatureValid = false;
	}

	if (!signatureValid) {
		throw new PasskeyAuthenticationError("invalid_signature", "Invalid signature");
	}

	return {
		credentialId: response.id,
		newCounter: authData.signatureCounter,
	};
}

/**
 * Authenticate a user with a passkey
 */
export async function authenticateWithPasskey(
	config: PasskeyConfig,
	adapter: AuthAdapter,
	response: AuthenticationResponse,
	challengeStore: ChallengeStore,
): Promise<User> {
	// Find the credential
	const credential = await adapter.getCredentialById(response.id);
	if (!credential) {
		throw new PasskeyAuthenticationError("credential_not_found", "Credential not found");
	}

	// Verify the response
	const verified = await verifyAuthenticationResponse(config, response, credential, challengeStore);

	// Update counter
	await adapter.updateCredentialCounter(verified.credentialId, verified.newCounter);

	// Get the user
	const user = await adapter.getUserById(credential.userId);
	if (!user) {
		throw new PasskeyAuthenticationError("user_not_found", "User not found");
	}

	return user;
}
