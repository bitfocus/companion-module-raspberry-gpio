// @ts-check
// M5Stack Chain wire protocol (UART 115200 8N1, daisy chained units).
// Frame: AA 55 | len_lo len_hi | id | cmd | data... | crc8 | 55 AA
//   len  = 3 + data length (id + cmd + data + crc), little endian
//   crc8 = 8-bit sum of id, cmd and data
// Taken from M5Stack's M5Chain library (MIT); this implementation is our own.

export const HEAD = [0xaa, 0x55]
export const TAIL = [0x55, 0xaa]
export const MIN_FRAME = 9
export const MAX_FRAME = 512
export const BROADCAST = 0xff

export const CMD = {
	SET_RGB: 0x20,
	GET_RGB: 0x21,
	SET_BRIGHTNESS: 0x22,
	GET_BRIGHTNESS: 0x23,
	EVENT: 0xe0,
	BUTTON_STATUS: 0xe1,
	BUTTON_SET_TIMEOUT: 0xe2,
	BUTTON_SET_MODE: 0xe4,
	UID: 0xf8,
	BOOTLOADER_VERSION: 0xf9,
	FW_VERSION: 0xfa,
	TYPE: 0xfb,
	ENUM_PLEASE: 0xfc,
	HEARTBEAT: 0xfd,
	ENUM: 0xfe,
	RESET: 0xff,
}

/**
 * @param {number} id
 * @param {number} cmd
 * @param {ArrayLike<number>} [data]
 * @returns {Buffer}
 */
export function encodeFrame(id, cmd, data = []) {
	const n = data.length
	const buf = Buffer.alloc(n + 9)
	buf[0] = 0xaa
	buf[1] = 0x55
	buf.writeUInt16LE(n + 3, 2)
	buf[4] = id & 0xff
	buf[5] = cmd & 0xff
	for (let i = 0; i < n; i++) buf[6 + i] = data[i] & 0xff
	let crc = 0
	for (let i = 4; i < 6 + n; i++) crc = (crc + buf[i]) & 0xff
	buf[6 + n] = crc
	buf[7 + n] = 0x55
	buf[8 + n] = 0xaa
	return buf
}

/**
 * @typedef {{ id: number, cmd: number, data: Buffer }} ChainFrame
 */

/**
 * Streaming frame parser. Feed it raw UART bytes; it returns every valid frame
 * and resynchronises on garbage, the same way M5Chain's processBufferData does.
 */
export class FrameParser {
	/** @type {Buffer} */
	#buf = Buffer.alloc(0)

	/**
	 * @param {Buffer} chunk
	 * @returns {ChainFrame[]}
	 */
	push(chunk) {
		this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk)
		/** @type {ChainFrame[]} */
		const frames = []
		let i = 0
		const b = this.#buf
		while (b.length - i >= MIN_FRAME) {
			if (b[i] !== 0xaa || b[i + 1] !== 0x55) {
				i++
				continue
			}
			const size = b.readUInt16LE(i + 2) + 6
			if (size < MIN_FRAME || size > MAX_FRAME) {
				i++
				continue
			}
			if (b.length - i < size) break
			if (b[i + size - 2] !== 0x55 || b[i + size - 1] !== 0xaa) {
				i++
				continue
			}
			let crc = 0
			for (let k = i + 4; k < i + size - 3; k++) crc = (crc + b[k]) & 0xff
			if (crc !== b[i + size - 3]) {
				i++
				continue
			}
			frames.push({ id: b[i + 4], cmd: b[i + 5], data: Buffer.from(b.subarray(i + 6, i + size - 3)) })
			i += size
		}
		// Keep at most one frame worth of tail so a stream of junk can't grow the buffer forever
		const rest = b.subarray(i)
		this.#buf = rest.length > MAX_FRAME ? Buffer.from(rest.subarray(rest.length - MAX_FRAME)) : Buffer.from(rest)
		return frames
	}

	reset() {
		this.#buf = Buffer.alloc(0)
	}
}
