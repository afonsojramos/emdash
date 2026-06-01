/**
 * Passkey registration (credential creation)
 */

import { encodeBase64urlNoPadding, decodeBase64urlIgnorePadding } from "@oslojs/encoding";

import { generateToken } from "../tokens.js";
import type { Credential, NewCredential, AuthAdapter, User, DeviceType } from "../types.js";
import { parseAttestationObject, parseClientDataJSON } from "./authenticator-data.js";
import { COSE_ALG_ES256, COSE_ALG_RS256, coseKeyToStored } from "./cose-key.js";
import type {
	RegistrationOptions,
	RegistrationResponse,
	VerifiedRegistration,
	ChallengeStore,
	PasskeyConfig,
} from "./types.js";
import { verifyRpIdHash } from "./verify.js";

const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

export type { PasskeyConfig };

/**
 * Generate registration options for creating a new passkey
 */
export async function generateRegistrationOptions(
	config: PasskeyConfig,
	user: Pick<User, "id" | "email" | "name">,
	existingCredentials: Credential[],
	challengeStore: ChallengeStore,
): Promise<RegistrationOptions> {
	const challenge = generateToken();

	// Store challenge for verification
	await challengeStore.set(challenge, {
		type: "registration",
		userId: user.id,
		expiresAt: Date.now() + CHALLENGE_TTL,
	});

	// Encode user ID as base64url
	const userIdBytes = new TextEncoder().encode(user.id);
	const userIdEncoded = encodeBase64urlNoPadding(userIdBytes);

	return {
		challenge,
		rp: {
			name: config.rpName,
			id: config.rpId,
		},
		user: {
			id: userIdEncoded,
			name: user.email,
			displayName: user.name || user.email,
		},
		pubKeyCredParams: [
			{ type: "public-key", alg: COSE_ALG_ES256 }, // ES256 (-7)
			{ type: "public-key", alg: COSE_ALG_RS256 }, // RS256 (-257)
		],
		timeout: 60000,
		attestation: "none", // We don't need attestation for our use case
		authenticatorSelection: {
			residentKey: "preferred", // Allow discoverable credentials
			userVerification: "preferred",
		},
		excludeCredentials: existingCredentials.map((cred) => ({
			type: "public-key" as const,
			id: cred.id,
			transports: cred.transports,
		})),
	};
}

/**
 * Verify a registration response and extract credential data
 */
export async function verifyRegistrationResponse(
	config: PasskeyConfig,
	response: RegistrationResponse,
	challengeStore: ChallengeStore,
): Promise<VerifiedRegistration> {
	// Decode the response
	const clientDataJSON = decodeBase64urlIgnorePadding(response.response.clientDataJSON);
	const attestationObject = decodeBase64urlIgnorePadding(response.response.attestationObject);

	// Parse client data
	const clientData = parseClientDataJSON(clientDataJSON);

	// Verify client data
	if (clientData.type !== "webauthn.create") {
		throw new Error("Invalid client data type");
	}

	// Verify challenge - normalize to base64url no-padding to match the stored format
	const challengeString = encodeBase64urlNoPadding(
		decodeBase64urlIgnorePadding(clientData.challenge),
	);
	const challengeData = await challengeStore.get(challengeString);
	if (!challengeData) {
		throw new Error("Challenge not found or expired");
	}
	if (challengeData.type !== "registration") {
		throw new Error("Invalid challenge type");
	}
	if (challengeData.expiresAt < Date.now()) {
		await challengeStore.delete(challengeString);
		throw new Error("Challenge expired");
	}

	// Delete challenge (single-use)
	await challengeStore.delete(challengeString);

	// Verify origin against the accepted list
	if (!config.origins.includes(clientData.origin)) {
		throw new Error(`Invalid origin: ${clientData.origin} not in [${config.origins.join(", ")}]`);
	}

	// Parse attestation object. Registration options request 'none' attestation,
	// so there is no attestation statement to verify -- we only extract the key.
	const { authenticatorData } = parseAttestationObject(attestationObject);

	// Verify RP ID hash
	if (!(await verifyRpIdHash(authenticatorData.rpIdHash, config.rpId))) {
		throw new Error("Invalid RP ID hash");
	}

	// Verify flags
	if (!authenticatorData.flags.userPresent) {
		throw new Error("User presence not verified");
	}

	// Extract credential data
	if (!authenticatorData.credential) {
		throw new Error("No credential data in attestation");
	}

	// Encode the COSE public key into the stored format:
	// ES256 -> SEC1 uncompressed point, RS256 -> SPKI DER.
	const { algorithm, publicKey } = coseKeyToStored(authenticatorData.credential.publicKey);

	// Backup-eligible credentials sync across devices (iCloud Keychain, Google
	// Password Manager); backup state reflects whether they currently are.
	const deviceType: DeviceType = authenticatorData.flags.backupEligible
		? "multiDevice"
		: "singleDevice";
	const backedUp = authenticatorData.flags.backupState;

	return {
		credentialId: response.id,
		publicKey,
		algorithm,
		counter: authenticatorData.signatureCounter,
		deviceType,
		backedUp,
		transports: response.response.transports ?? [],
	};
}

/**
 * Register a new passkey for a user
 */
export async function registerPasskey(
	adapter: AuthAdapter,
	userId: string,
	verified: VerifiedRegistration,
	name?: string,
): Promise<Credential> {
	// Check credential limit
	const count = await adapter.countCredentialsByUserId(userId);
	if (count >= 10) {
		throw new Error("Maximum number of passkeys reached (10)");
	}

	// Check if credential already exists
	const existing = await adapter.getCredentialById(verified.credentialId);
	if (existing) {
		throw new Error("Credential already registered");
	}

	const newCredential: NewCredential = {
		id: verified.credentialId,
		userId,
		publicKey: verified.publicKey,
		algorithm: verified.algorithm,
		counter: verified.counter,
		deviceType: verified.deviceType,
		backedUp: verified.backedUp,
		transports: verified.transports,
		name,
	};

	return adapter.createCredential(newCredential);
}
