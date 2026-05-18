// HMAC-SHA256 webhook signature verification for GitHub webhook deliveries.
//
// GitHub signs the *raw request body bytes* with the webhook secret and
// sends the result as `X-Hub-Signature-256: sha256=<hex>`. The signature
// must be computed against the raw bytes, NOT a re-serialised JSON
// payload, otherwise any whitespace or key-order drift breaks verification.
//
// We use Web Crypto (available on Cloudflare Workers) and a constant-time
// compare to avoid timing leaks on the hex digest.

const encoder = new TextEncoder();

export async function verifyGitHubSignature(
	secret: string,
	rawBody: ArrayBuffer | Uint8Array | string,
	signatureHeader: string | null,
): Promise<boolean> {
	if (!secret || !signatureHeader) return false;

	// Normalise to ArrayBuffer for crypto.subtle.sign — Uint8Array typings
	// allow SharedArrayBuffer-backed views which crypto.subtle rejects.
	let bodyBuffer: ArrayBuffer;
	if (typeof rawBody === "string") {
		// encoder.encode returns Uint8Array<ArrayBuffer> — copy into a
		// fresh ArrayBuffer to satisfy the BufferSource contract.
		const bytes = encoder.encode(rawBody);
		const copy = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(copy).set(bytes);
		bodyBuffer = copy;
	} else if (rawBody instanceof Uint8Array) {
		// Copy into a fresh ArrayBuffer to guarantee non-shared backing.
		const copy = new ArrayBuffer(rawBody.byteLength);
		new Uint8Array(copy).set(rawBody);
		bodyBuffer = copy;
	} else {
		bodyBuffer = rawBody;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, bodyBuffer);
	const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
	const expected = `sha256=${hex}`;

	return constantTimeEqual(expected, signatureHeader);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
