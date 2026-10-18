// @ts-check
// Minimal Companion Satellite API client: the Chain shows up in Companion as a surface, so it
// follows whatever page that surface is on, and button colours come back for the unit LEDs.
import { EventEmitter } from 'node:events'
import * as net from 'node:net'

/**
 * Split `NAME KEY=VAL KEY="quoted val"` into its parts.
 * @param {string} line
 * @returns {{ name: string, params: Record<string, string | true> }}
 */
export function parseSatelliteLine(line) {
	const trimmed = line.trim()
	const sp = trimmed.indexOf(' ')
	const name = sp === -1 ? trimmed : trimmed.slice(0, sp)
	/** @type {Record<string, string | true>} */
	const params = {}
	const re = /([A-Za-z0-9_-]+)(?:=(?:"((?:[^"\\]|\\.)*)"|(\S*)))?/g
	const rest = sp === -1 ? '' : trimmed.slice(sp + 1)
	let m
	while ((m = re.exec(rest))) {
		params[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3] !== undefined ? m[3] : true
	}
	return { name, params }
}

/** @param {Record<string, string | number | boolean>} args */
function formatArgs(args) {
	return Object.entries(args)
		.map(([k, v]) => {
			const s = String(v)
			return /[\s"]/.test(s) ? `${k}="${s.replace(/(["\\])/g, '\\$1')}"` : `${k}=${s}`
		})
		.join(' ')
}

/**
 * @param {string | true | undefined} c `#rrggbb` or `rgb(r,g,b)`
 * @returns {[number, number, number] | null}
 */
export function parseColor(c) {
	if (typeof c !== 'string') return null
	let m = /^#?([0-9a-f]{6})$/i.exec(c.trim())
	if (m) {
		const n = parseInt(m[1], 16)
		return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
	}
	m = /^rgb\((\d+),(\d+),(\d+)\)$/i.exec(c.replace(/\s/g, ''))
	if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
	return null
}

/**
 * Events: 'connected', 'disconnected', 'key-state' (key: number, rgb: [r,g,b] | null, pressed: boolean),
 * 'sub-state' (subId: string, rgb: [r,g,b] | null), 'subscriptions' (available: boolean), 'log' (level, message)
 */
export class SatelliteClient extends EventEmitter {
	/** @type {net.Socket | null} */
	#socket = null
	#buf = ''
	/** @type {NodeJS.Timeout | null} */
	#ping = null
	/** @type {NodeJS.Timeout | null} */
	#retry = null
	#stopped = false
	#deviceAdded = false
	connected = false
	/** Companion allows button subscriptions (Settings, Satellite, Button Subscriptions API) */
	canSubscribe = false
	/** @type {Map<string, string>} subId -> "page/row/column" */
	#subs = new Map()

	/**
	 * @param {{ host: string, port: number, deviceId: string, productName: string, keysTotal: number, keysPerRow: number, registerDevice?: boolean }} opts
	 */
	constructor(opts) {
		super()
		this.opts = opts
	}

	start() {
		this.#stopped = false
		this.#connect()
	}

	stop() {
		this.#stopped = true
		if (this.#retry) clearTimeout(this.#retry)
		if (this.#ping) clearInterval(this.#ping)
		if (this.#socket) {
			if (this.#deviceAdded) this.#send(`REMOVE-DEVICE DEVICEID=${this.opts.deviceId}`)
			this.#socket.end()
			this.#socket.destroy()
		}
		this.#socket = null
	}

	/** Change the surface size (devices came or went). @param {number} keysTotal @param {number} keysPerRow */
	resize(keysTotal, keysPerRow) {
		if (keysTotal === this.opts.keysTotal && keysPerRow === this.opts.keysPerRow) return
		this.opts = { ...this.opts, keysTotal, keysPerRow }
		if (this.connected && this.opts.registerDevice !== false) {
			if (this.#deviceAdded) this.#send(`REMOVE-DEVICE DEVICEID=${this.opts.deviceId}`)
			this.#addDevice()
		}
	}

	/**
	 * Follow one button's look, wherever it is. Needs Companion's Button Subscriptions API.
	 * @param {Map<string, { page: number, row: number, column: number }>} wanted subId -> location
	 */
	setSubscriptions(wanted) {
		/** @type {Map<string, string>} */
		const next = new Map([...wanted].map(([id, l]) => [id, `${l.page}/${l.row}/${l.column}`]))
		for (const [id, loc] of this.#subs) {
			if (next.get(id) !== loc && this.canSubscribe) this.#send(`REMOVE-SUB SUBID=${id}`)
		}
		const old = this.#subs
		this.#subs = next
		for (const [id, loc] of next) {
			if (old.get(id) !== loc && this.canSubscribe) this.#addSub(id, loc)
		}
	}

	/** @param {string} id @param {string} loc */
	#addSub(id, loc) {
		this.#send(`ADD-SUB ${formatArgs({ SUBID: id, LOCATION: loc, COLORS: 'hex', TEXT: false })}`)
	}

	/** @param {number} key @param {boolean} pressed */
	keyPress(key, pressed) {
		if (!this.#deviceAdded) return
		this.#send(`KEY-PRESS ${formatArgs({ DEVICEID: this.opts.deviceId, KEY: key, PRESSED: pressed })}`)
	}

	/** @param {number} key @param {number} steps signed; old Companion only takes one step per message */
	keyRotate(key, steps) {
		if (!this.#deviceAdded || !steps) return
		const dir = steps > 0 ? 1 : -1
		for (let i = 0; i < Math.min(Math.abs(steps), 100); i++) {
			this.#send(`KEY-ROTATE ${formatArgs({ DEVICEID: this.opts.deviceId, KEY: key, DIRECTION: dir })}`)
		}
	}

	#connect() {
		if (this.#stopped) return
		const sock = net.createConnection({ host: this.opts.host, port: this.opts.port })
		this.#socket = sock
		sock.setNoDelay(true)
		sock.on('connect', () => {
			this.connected = true
			this.emit('log', 'info', `Satellite connected to ${this.opts.host}:${this.opts.port}`)
			this.#ping = setInterval(() => this.#send('PING'), 2000)
		})
		sock.on('data', (d) => {
			this.#buf += d.toString('utf8')
			let nl
			while ((nl = this.#buf.indexOf('\n')) !== -1) {
				const line = this.#buf.slice(0, nl)
				this.#buf = this.#buf.slice(nl + 1)
				if (line.trim()) this.#onLine(line)
			}
		})
		sock.on('error', (e) => this.emit('log', 'debug', `Satellite: ${e.message}`))
		sock.on('close', () => {
			const was = this.connected
			this.connected = false
			this.#deviceAdded = false
			this.canSubscribe = false
			this.#buf = ''
			if (this.#ping) clearInterval(this.#ping)
			this.#ping = null
			if (was) this.emit('disconnected')
			if (!this.#stopped) this.#retry = setTimeout(() => this.#connect(), 3000)
		})
	}

	#addDevice() {
		this.#send(
			`ADD-DEVICE ${formatArgs({
				DEVICEID: this.opts.deviceId,
				PRODUCT_NAME: this.opts.productName,
				KEYS_TOTAL: Math.max(1, this.opts.keysTotal),
				KEYS_PER_ROW: Math.max(1, Math.min(this.opts.keysPerRow, this.opts.keysTotal || 1)),
				BITMAPS: 0,
				COLORS: 'hex',
				TEXT: false,
			})}`,
		)
	}

	/** @param {string} line */
	#onLine(line) {
		const { name, params } = parseSatelliteLine(line)
		switch (name) {
			case 'BEGIN':
				if (this.opts.registerDevice !== false) this.#addDevice()
				break
			case 'CAPS':
				this.canSubscribe = params.SUBSCRIPTIONS === '1' || params.SUBSCRIPTIONS === 'true'
				this.emit('subscriptions', this.canSubscribe)
				if (this.canSubscribe) for (const [id, loc] of this.#subs) this.#addSub(id, loc)
				break
			case 'ADD-SUB':
				if (line.includes(' ERROR'))
					this.emit('log', 'warn', `Companion refused a button subscription: ${params.MESSAGE ?? line}`)
				break
			case 'SUB-STATE':
				if (typeof params.SUBID === 'string') this.emit('sub-state', params.SUBID, parseColor(params.COLOR))
				break
			case 'ADD-DEVICE':
				if (line.includes(' OK')) {
					this.#deviceAdded = true
					this.emit('connected')
				} else if (line.includes(' ERROR')) {
					this.emit('log', 'warn', `Companion refused the Chain surface: ${params.MESSAGE ?? line}`)
				}
				break
			case 'KEY-STATE':
				if (params.DEVICEID === this.opts.deviceId && params.KEY !== undefined) {
					this.emit(
						'key-state',
						Number(params.KEY),
						parseColor(params.COLOR),
						params.PRESSED === 'true' || params.PRESSED === '1',
					)
				}
				break
			case 'PING':
				this.#send(`PONG ${line.slice(5)}`)
				break
		}
	}

	/** @param {string} s */
	#send(s) {
		if (this.#socket && !this.#socket.destroyed) this.#socket.write(s + '\n')
	}
}
