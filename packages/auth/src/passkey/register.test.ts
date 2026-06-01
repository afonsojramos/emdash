import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { COSE_ALG_ES256, COSE_ALG_RS256 } from "./cose-key.js";
import { verifyRegistrationResponse } from "./register.js";
import type { ChallengeStore, PasskeyConfig } from "./types.js";

const config: PasskeyConfig = {
	rpName: "Test Site",
	rpId: "example.com",
	origins: ["https://example.com"],
};

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function makeChallengeStore(): ChallengeStore {
	return {
		set: vi.fn(async () => undefined),
		get: vi.fn(async () => ({
			type: "registration" as const,
			userId: "user_1",
			expiresAt: Date.now() + 60_000,
		})),
		delete: vi.fn(async () => undefined),
	};
}

// --- Minimal CBOR encoder for building real attestation fixtures ---

function cborHead(major: number, value: number): Uint8Array {
	const tag = major << 5;
	if (value < 24) return new Uint8Array([tag | value]);
	if (value < 0x100) return new Uint8Array([tag | 24, value]);
	if (value < 0x10000) return new Uint8Array([tag | 25, value >> 8, value & 0xff]);
	return new Uint8Array([
		tag | 26,
		value >>> 24,
		(value >> 16) & 0xff,
		(value >> 8) & 0xff,
		value & 0xff,
	]);
}

function concat(parts: Uint8Array[]): Uint8Array {
	return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

function cborUint(n: number): Uint8Array {
	return cborHead(0, n);
}

function cborInt(n: number): Uint8Array {
	return n < 0 ? cborHead(1, -1 - n) : cborHead(0, n);
}

function cborBytes(b: Uint8Array): Uint8Array {
	return concat([cborHead(2, b.length), b]);
}

function cborText(s: string): Uint8Array {
	const bytes = new TextEncoder().encode(s);
	return concat([cborHead(3, bytes.length), bytes]);
}

function cborMap(entries: Array<[Uint8Array, Uint8Array]>): Uint8Array {
	return concat([cborHead(5, entries.length), ...entries.flat()]);
}

function buildAuthData(coseKey: Uint8Array): Uint8Array {
	const rpIdHash = createHash("sha256").update(config.rpId).digest();
	const flags = Buffer.from([0x41]); // AT | UP
	const signCount = Buffer.alloc(4);
	const aaguid = Buffer.alloc(16);
	const credId = Buffer.alloc(16, 1);
	const credIdLen = Buffer.alloc(2);
	credIdLen.writeUInt16BE(credId.length);
	return concat([rpIdHash, flags, signCount, aaguid, credIdLen, credId, coseKey]);
}

function buildAttestationObject(coseKey: Uint8Array): string {
	const attestationObject = cborMap([
		[cborText("fmt"), cborText("none")],
		[cborText("attStmt"), cborMap([])],
		[cborText("authData"), cborBytes(buildAuthData(coseKey))],
	]);
	return base64url(attestationObject);
}

function clientData(origin = config.origins[0]!): string {
	const challenge = base64url(Buffer.from("test-challenge"));
	return base64url(Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin })));
}

function es256CoseKey(): { coseKey: Uint8Array; x: Buffer; y: Buffer } {
	const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = publicKey.export({ format: "jwk" });
	const x = Buffer.from(jwk.x!, "base64url");
	const y = Buffer.from(jwk.y!, "base64url");
	const coseKey = cborMap([
		[cborInt(1), cborUint(2)], // kty: EC2
		[cborInt(3), cborInt(COSE_ALG_ES256)],
		[cborInt(-1), cborUint(1)], // crv: P-256
		[cborInt(-2), cborBytes(x)],
		[cborInt(-3), cborBytes(y)],
	]);
	return { coseKey, x, y };
}

function rs256CoseKey(): {
	coseKey: Uint8Array;
	jwk: ReturnType<ReturnType<typeof generateKeyPairSync>["publicKey"]["export"]>;
} {
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" });
	const coseKey = cborMap([
		[cborInt(1), cborUint(3)], // kty: RSA
		[cborInt(3), cborInt(COSE_ALG_RS256)],
		[cborInt(-1), cborBytes(Buffer.from((jwk as { n: string }).n, "base64url"))],
		[cborInt(-2), cborBytes(Buffer.from((jwk as { e: string }).e, "base64url"))],
	]);
	return { coseKey, jwk };
}

describe("verifyRegistrationResponse", () => {
	it("rejects an origin not in the accepted list", async () => {
		await expect(
			verifyRegistrationResponse(
				config,
				{
					id: "test-credential",
					rawId: "test-credential",
					type: "public-key",
					response: {
						clientDataJSON: clientData("https://attacker.com"),
						attestationObject: "AA",
					},
				},
				makeChallengeStore(),
			),
		).rejects.toThrow(/Invalid origin: https:\/\/attacker\.com not in/);
	});

	it("parses a real ES256 attestation and stores a SEC1 uncompressed point", async () => {
		const { coseKey, x, y } = es256CoseKey();
		const result = await verifyRegistrationResponse(
			config,
			{
				id: "test-credential",
				rawId: "test-credential",
				type: "public-key",
				response: {
					clientDataJSON: clientData(),
					attestationObject: buildAttestationObject(coseKey),
				},
			},
			makeChallengeStore(),
		);

		expect(result.algorithm).toBe(COSE_ALG_ES256);
		expect(result.publicKey).toEqual(new Uint8Array(Buffer.concat([Buffer.from([0x04]), x, y])));
	});

	it("parses a real RS256 attestation and stores an importable SPKI key", async () => {
		const { coseKey, jwk } = rs256CoseKey();
		const result = await verifyRegistrationResponse(
			config,
			{
				id: "test-credential",
				rawId: "test-credential",
				type: "public-key",
				response: {
					clientDataJSON: clientData(),
					attestationObject: buildAttestationObject(coseKey),
				},
			},
			makeChallengeStore(),
		);

		expect(result.algorithm).toBe(COSE_ALG_RS256);
		// The stored SPKI round-trips back to the original modulus/exponent.
		const roundTripped = createPublicKey({
			key: Buffer.from(result.publicKey),
			format: "der",
			type: "spki",
		}).export({ format: "jwk" });
		expect((roundTripped as { n: string }).n).toBe((jwk as { n: string }).n);
		expect((roundTripped as { e: string }).e).toBe((jwk as { e: string }).e);
	});
});
