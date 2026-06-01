/**
 * Strict, minimal CBOR decoder (RFC 8949) scoped to WebAuthn.
 *
 * WebAuthn only ever hands us definite-length maps/arrays of integers, byte
 * strings, and text strings (COSE keys, the attestation object, extension
 * maps). This decoder supports exactly that and rejects everything else --
 * tags, floats, simple values, indefinite-length items, and anything that
 * over-runs the buffer. A scoped parser is a smaller attack surface than a
 * general one: malformed or unexpected input is rejected rather than coerced.
 */

const MAX_DEPTH = 16;

export type CborValue = number | Uint8Array | string | CborValue[] | CborMap;
export type CborMap = Map<number | string, CborValue>;

export class CborError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CborError";
	}
}

/**
 * Decode a single CBOR item and assert the entire buffer was consumed.
 * Use this when the input is expected to be exactly one item with no trailing
 * bytes (the attestation object, an extension map).
 */
export function decodeCbor(bytes: Uint8Array): CborValue {
	const reader = new CborReader(bytes);
	const value = reader.read();
	if (!reader.atEnd) {
		throw new CborError("unexpected trailing bytes after CBOR item");
	}
	return value;
}

export class CborReader {
	private readonly view: DataView;
	offset: number;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.offset = 0;
	}

	get atEnd(): boolean {
		return this.offset >= this.bytes.length;
	}

	read(): CborValue {
		return this.readValue(0);
	}

	private readValue(depth: number): CborValue {
		if (depth > MAX_DEPTH) {
			throw new CborError("CBOR nesting too deep");
		}
		const initial = this.readByte();
		const major = initial >> 5;
		const info = initial & 0x1f;

		switch (major) {
			case 0:
				return this.readArgument(info);
			case 1:
				return -1 - this.readArgument(info);
			case 2:
				return this.readBytes(this.readLength(info));
			case 3:
				return this.readText(this.readLength(info));
			case 4:
				return this.readArray(this.readLength(info), depth);
			case 5:
				return this.readMap(this.readLength(info), depth);
			default:
				// 6 = tag, 7 = float/simple -- unsupported.
				throw new CborError(`unsupported CBOR major type ${major}`);
		}
	}

	private readArgument(info: number): number {
		if (info < 24) return info;
		switch (info) {
			case 24:
				return this.readByte();
			case 25: {
				const v = this.view.getUint16(this.take(2), false);
				return v;
			}
			case 26:
				return this.view.getUint32(this.take(4), false);
			case 27: {
				const high = this.view.getUint32(this.take(4), false);
				const low = this.view.getUint32(this.offset, false);
				this.offset += 4;
				if (high > 0x001f_ffff) {
					// Would exceed Number.MAX_SAFE_INTEGER; no legitimate WebAuthn
					// integer or length is this large.
					throw new CborError("CBOR integer too large");
				}
				return high * 0x1_0000_0000 + low;
			}
			default:
				// 28-30 reserved, 31 indefinite-length.
				throw new CborError(`unsupported CBOR additional info ${info}`);
		}
	}

	private readLength(info: number): number {
		const length = this.readArgument(info);
		if (length > this.bytes.length - this.offset) {
			throw new CborError("CBOR length exceeds buffer");
		}
		return length;
	}

	private readArray(length: number, depth: number): CborValue[] {
		const items: CborValue[] = [];
		for (let i = 0; i < length; i++) {
			items.push(this.readValue(depth + 1));
		}
		return items;
	}

	private readMap(length: number, depth: number): CborMap {
		const map: CborMap = new Map();
		for (let i = 0; i < length; i++) {
			const key = this.readValue(depth + 1);
			if (typeof key !== "number" && typeof key !== "string") {
				throw new CborError("CBOR map key must be an integer or text string");
			}
			if (map.has(key)) {
				throw new CborError("duplicate CBOR map key");
			}
			map.set(key, this.readValue(depth + 1));
		}
		return map;
	}

	private readByte(): number {
		if (this.offset >= this.bytes.length) {
			throw new CborError("unexpected end of CBOR input");
		}
		return this.bytes[this.offset++]!;
	}

	private readBytes(length: number): Uint8Array {
		const start = this.take(length);
		return this.bytes.slice(start, start + length);
	}

	private readText(length: number): string {
		const start = this.take(length);
		return new TextDecoder("utf-8", { fatal: true }).decode(
			this.bytes.subarray(start, start + length),
		);
	}

	/** Reserve `count` bytes, returning the start offset and advancing past them. */
	private take(count: number): number {
		if (count > this.bytes.length - this.offset) {
			throw new CborError("unexpected end of CBOR input");
		}
		const start = this.offset;
		this.offset += count;
		return start;
	}
}
