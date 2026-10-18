// @ts-check
// A Chain bus in software: answers frames the way real units do, so the module can be
// tried without hardware. Also used by the tests.
import { EventEmitter } from 'node:events'
import { BROADCAST, CMD, FrameParser, encodeFrame } from './protocol.js'
import { typeFromName } from './types.js'

/**
 * @typedef {{ type: string, code: number, uid: Buffer, pressed: number, value: number, raw: number,
 *   x: number, y: number, on: number, distance: number, person: number,
 *   led: number[], brightness: number, report: number }} SimUnit
 */

export class SimulatedChain extends EventEmitter {
	name = 'simulated'
	/** @type {SimUnit[]} */
	units = []
	#parser = new FrameParser()
	#closed = false

	/** @param {string[]} [types] e.g. ['key', 'encoder', 'joystick', 'angle'] */
	constructor(types = []) {
		super()
		for (const t of types) this.#add(t)
	}

	/** @param {string} type */
	#add(type) {
		const t = typeFromName(type.trim().toLowerCase())
		if (!t) throw new Error(`Unknown Chain type "${type}"`)
		// Stable per position and type, so a restarted simulator looks like the same hardware
		const uid = Buffer.from([0x51, t.code, 0x00, this.units.length + 1])
		/** @type {SimUnit} */
		const unit = {
			type: t.name,
			code: t.code,
			uid,
			pressed: 0,
			value: 0,
			raw: 2048,
			x: 0,
			y: 0,
			on: 0,
			distance: 500,
			person: 0,
			led: [0, 0, 0],
			brightness: 100,
			report: 0,
		}
		this.units.push(unit)
		return unit
	}

	/** @param {Buffer} buf */
	write(buf) {
		if (this.#closed) throw new Error('port closed')
		for (const f of this.#parser.push(buf)) {
			const reply = this.#answer(f.id, f.cmd, f.data)
			if (reply) setImmediate(() => !this.#closed && this.emit('data', encodeFrame(reply[0], f.cmd, reply[1])))
		}
	}

	close() {
		this.#closed = true
		this.emit('close')
	}

	/**
	 * @param {number} id @param {number} cmd @param {Buffer} data
	 * @returns {[number, number[]] | null}
	 */
	#answer(id, cmd, data) {
		if (id === BROADCAST) {
			if (cmd === CMD.ENUM) return this.units.length ? [BROADCAST, [this.units.length]] : null
			if (cmd === CMD.HEARTBEAT) return this.units.length ? [BROADCAST, []] : null
			return null
		}
		const u = this.units[id - 1]
		if (!u) return null
		const le16 = (/** @type {number} */ v) => [v & 0xff, (v >> 8) & 0xff]
		switch (cmd) {
			case CMD.HEARTBEAT:
				return [id, []]
			case CMD.TYPE:
				return [id, le16(u.code)]
			case CMD.UID:
				return [id, [1, ...u.uid]]
			case CMD.FW_VERSION:
				return [id, [3]]
			case CMD.SET_RGB:
				u.led = [data[2], data[3], data[4]]
				this.emit('led', id, u.led)
				return [id, [1]]
			case CMD.SET_BRIGHTNESS:
				u.brightness = data[0]
				return [id, [1]]
		}
		switch (u.type) {
			case 'key':
			case 'encoder':
			case 'joystick':
			case 'pedal':
				if (cmd === CMD.BUTTON_STATUS) return [id, [u.pressed]]
				if (cmd === 0xe4 || (u.type === 'pedal' && cmd === 0xe5)) {
					u.report = data[0]
					return [id, [1]]
				}
				if (u.type === 'pedal' && cmd === 0xe2) return [id, [u.on]]
				if (u.type === 'encoder' && cmd === 0x10) return [id, le16(u.value)]
				if (u.type === 'encoder' && cmd === 0x13) {
					u.value = 0
					return [id, [1]]
				}
				if (u.type === 'joystick' && cmd === 0x35) return [id, [u.x & 0xff, u.y & 0xff]]
				return null
			case 'angle':
			case 'switch':
				if (cmd === 0x30) return [id, le16(u.raw)]
				if (cmd === 0x36) return [id, [u.on]]
				if (cmd === 0xe1) return [id, [1]]
				return null
			case 'tof':
				return cmd === 0x50 ? [id, le16(u.distance)] : null
			case 'pir':
				if (cmd === 0x37) return [id, [u.person]]
				if (cmd === 0xe1) return [id, [1]]
				return null
		}
		return null
	}

	// ---- things a person would do to the hardware ----

	/** @param {number} index 1-based */
	unit(index) {
		const u = this.units[index - 1]
		if (!u) throw new Error(`No simulated unit at position ${index}`)
		return u
	}

	/** @param {number} index @param {boolean} down */
	press(index, down) {
		this.unit(index).pressed = down ? 1 : 0
	}

	/** @param {number} index @param {'single'|'double'|'long'} kind */
	click(index, kind) {
		const u = this.unit(index)
		if (!u.report) return
		const code = { single: 0, double: 1, long: 2 }[kind]
		this.emit('data', encodeFrame(index, CMD.EVENT, [code, 0]))
	}

	/** @param {number} index @param {number} steps */
	turn(index, steps) {
		const u = this.unit(index)
		u.value = ((((u.value + steps + 32768) % 65536) + 65536) % 65536) - 32768
	}

	/** Joystick, -127..127 per axis. @param {number} index @param {number} x @param {number} y */
	stick(index, x, y) {
		const u = this.unit(index)
		u.x = Math.max(-127, Math.min(127, Math.round(x)))
		u.y = Math.max(-127, Math.min(127, Math.round(y)))
	}

	/** Angle / slider, 0..4095. @param {number} index @param {number} raw */
	knob(index, raw) {
		this.unit(index).raw = Math.max(0, Math.min(4095, Math.round(raw)))
	}

	/** Plug a unit onto the end of the chain; it asks the host to enumerate. @param {string} type */
	plug(type) {
		const u = this.#add(type)
		this.emit('data', encodeFrame(this.units.length, CMD.ENUM_PLEASE, []))
		return u
	}

	/** Pull the unit at a position and everything after it, like unplugging a cable. @param {number} index */
	unplugFrom(index) {
		this.units.splice(index - 1)
	}
}
