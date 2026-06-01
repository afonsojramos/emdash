---
"@emdash-cms/auth": patch
"emdash": patch
---

Replaces the `@oslojs/webauthn` dependency and the `@oslojs/crypto` signature-verification primitives in the passkey path with a hand-rolled, strict WebAuthn parser and WebCrypto-based verification. The new CBOR decoder only accepts the definite-length maps, integers, and byte strings that COSE keys and the attestation object use -- rejecting tags, floats, indefinite lengths, over-long inputs, and (unlike before) validating extension data rather than ignoring it. ECDSA and RSA signatures are now verified via `crypto.subtle`.

Stored credential formats are unchanged (SEC1 uncompressed for ES256, SPKI for RS256), so existing passkeys keep working. Newly registered passkeys now record the correct `deviceType`/`backedUp` values from the authenticator's backup-eligibility flags, which the previous parser did not expose.
