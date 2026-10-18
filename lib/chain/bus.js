// @ts-check
import { EventEmitter } from 'node:events'
import { BROADCAST, CMD, FrameParser, encodeFrame } from './protocol.js'
import { EVENT, typeFromCode } from './types.js'

/**
 * @typedef {import('./types.js').ChainType} ChainType
 * @typedef {import('./types.js').DeviceState} DeviceState
 * @typedef {{
 *   on(event: 'data', cb: (chunk: Buffer) => void): any,
 *   on(event: 'error', cb: (err: Error) => void): any,
 *   on(event: 'close', cb: () => void): any,
 *   write(buf: Buffer): void,
 *   close(): void,
 *   name: string,
 * }} ChainTransport
 * @typedef {{
 *   index: number,
 *   type: ChainType,
 *   uid: string,
 *   fw: number,
 *   key: string,
 *   state: DeviceState,
 * }} ChainDevice
 */

/**
 * @typedef {{ id: number, cmd: number, data: number[], timeout: number, resolve: (d: Buffer) => void, reject: (e: Error) => void }} Pending
 */

export class ChainTimeout extends Error {}

/**
 * One Chain bus: enumeration, hot-plug, polling and LED writes.
 *
 * Events:
 *  - 'devices' (devices: ChainDevice[], added: ChainDevice[], removed: ChainDevice[])
 *  - 'state' (device: ChainDevice, changes: DeviceState)
 *  - 'click' (device: ChainDevice, kind: 'single'|'double'|'long')
 *  - 'status' (status: 'ok'|'empty'|'no-reply'|'error', message: string)
 *  - 'log' (level, message)
 */
export class ChainBus extends EventEmitter {
	/** @type {ChainDevice[]} */
	devices = []
	/** @type {'ok'|'empty'|'no-reply'|'error'|'starting'} */
	status = 'starting'

	#transport
	#parser = new FrameParser()
	/** @type {Pending[]} */
	#queue = []
	/** @type {Pending | null} */
	#current = null
	/** @type {NodeJS.Timeout | null} */
	#timer = null
	#running = false
	#rescanWanted = true
	#lastScanAt = 0
	#failures = 0
	#enumFailures = 0
	#opts

	/**
	 * @param {ChainTransport} transport
	 * @param {{ pollInterval?: number, rescanInterval?: number, timeout?: number }} [opts]
	 */
	constructor(transport, opts = {}) {
		super()
		this.#transport = transport
		this.#opts = { pollInterval: 20, rescanInterval: 5000, timeout: 60, ...opts }
		transport.on('data', (chunk) => this.#onData(chunk))
		transport.on('error', (err) => this.#setStatus('error', err.message))
	}

	start() {
		if (this.#running) return
		this.#running = true
		this.#loop().catch((e) => this.emit('log', 'error', `Chain loop stopped: ${e?.message ?? e}`))
	}

	stop() {
		this.#running = false
		if (this.#timer) clearTimeout(this.#timer)
		this.#timer = null
		for (const p of [...this.#queue, ...(this.#current ? [this.#current] : [])]) p.reject(new Error('bus closed'))
		this.#queue = []
		this.#current = null
		try {
			this.#transport.close()
		} catch {
			// already closed
		}
	}

	rescan() {
		this.#rescanWanted = true
	}

	/**
	 * Send one request and wait for the matching reply.
	 * @param {number} id
	 * @param {number} cmd
	 * @param {number[]} [data]
	 * @param {{ urgent?: boolean, timeout?: number }} [o]
	 * @returns {Promise<Buffer>}
	 */
	request(id, cmd, data = [], o = {}) {
		return new Promise((resolve, reject) => {
			/** @type {Pending} */
			const p = { id, cmd, data, timeout: o.timeout ?? this.#opts.timeout, resolve, reject }
			if (o.urgent) this.#queue.unshift(p)
			else this.#queue.push(p)
			this.#pump()
		})
	}

	/** @param {ChainDevice} dev @param {number} r @param {number} g @param {number} b */
	setLed(dev, r, g, b) {
		return this.request(dev.index, CMD.SET_RGB, [0, 1, r, g, b], { urgent: true })
	}

	/** @param {ChainDevice} dev @param {number} percent 0..100 */
	setBrightness(dev, percent) {
		const v = Math.max(0, Math.min(100, Math.round(percent)))
		return this.request(dev.index, CMD.SET_BRIGHTNESS, [v, 0], { urgent: true })
	}

	/** @param {ChainDevice} dev */
	resetEncoder(dev) {
		return this.request(dev.index, 0x13, [], { urgent: true })
	}

	#pump() {
		if (this.#current || !this.#queue.length) return
		const p = /** @type {Pending} */ (this.#queue.shift())
		this.#current = p
		const t = setTimeout(() => {
			if (this.#current !== p) return
			this.#current = null
			p.reject(new ChainTimeout(`no reply to 0x${p.cmd.toString(16)} from ${p.id}`))
			this.#pump()
		}, p.timeout)
		const resolve = p.resolve
		p.resolve = (d) => {
			clearTimeout(t)
			resolve(d)
		}
		try {
			this.#transport.write(encodeFrame(p.id, p.cmd, p.data))
		} catch (e) {
			clearTimeout(t)
			this.#current = null
			p.reject(/** @type {Error} */ (e))
			this.#pump()
		}
	}

	/** @param {Buffer} chunk */
	#onData(chunk) {
		for (const f of this.#parser.push(chunk)) {
			const p = this.#current
			if (p && f.cmd === p.cmd && (f.id === p.id || p.id === BROADCAST)) {
				this.#current = null
				p.resolve(f.data)
				this.#pump()
			} else if (f.cmd === CMD.ENUM_PLEASE) {
				this.emit('log', 'debug', 'Chain: a unit asked for enumeration')
				this.#rescanWanted = true
			} else if (f.cmd === CMD.EVENT) {
				this.#onEvent(f.id, f.data.length >= 2 ? f.data.readUInt16LE(0) : (f.data[0] ?? 0))
			}
		}
	}

	/** @param {number} index @param {number} code */
	#onEvent(index, code) {
		const dev = this.devices.find((d) => d.index === index)
		const ev = /** @type {Record<number, DeviceState>} */ (EVENT)[code]
		if (!dev || !ev) return
		if (ev.click) {
			dev.state.click = ev.click
			this.emit('click', dev, ev.click)
			this.emit('state', dev, { click: ev.click })
		} else {
			this.#applyState(dev, ev)
		}
	}

	/** @param {ChainDevice} dev @param {DeviceState} next */
	#applyState(dev, next) {
		/** @type {DeviceState} */
		const changes = {}
		for (const [k, v] of Object.entries(next)) {
			if (dev.state[k] !== v) changes[k] = v
		}
		if (dev.type.name === 'encoder' && 'value' in changes && typeof dev.state.value === 'number') {
			// int16 counter: take the short way round when it wraps
			let d = Number(changes.value) - dev.state.value
			if (d > 32767) d -= 65536
			if (d < -32768) d += 65536
			changes.delta = d
		}
		if (!Object.keys(changes).length) return
		Object.assign(dev.state, changes)
		this.emit('state', dev, changes)
	}

	/** @param {'ok'|'empty'|'no-reply'|'error'} status @param {string} msg */
	#setStatus(status, msg) {
		if (this.status === status) return
		this.status = status
		this.emit('status', status, msg)
	}

	async #loop() {
		while (this.#running) {
			const now = Date.now()
			try {
				if (this.#rescanWanted || now - this.#lastScanAt > this.#opts.rescanInterval) {
					await this.#scan(this.#rescanWanted)
				} else {
					await this.#pollAll()
				}
				this.#failures = 0
			} catch (e) {
				if (!(e instanceof ChainTimeout)) throw e
				if (++this.#failures >= 3) this.#rescanWanted = true
			}
			await new Promise((r) => (this.#timer = setTimeout(r, this.devices.length ? this.#opts.pollInterval : 1000)))
		}
	}

	/**
	 * ENUM tells us how many units there are. Only when that changes (or we were asked to) do we
	 * walk the chain for types and UIDs, so the periodic check costs one request.
	 * @param {boolean} full
	 */
	async #scan(full) {
		this.#lastScanAt = Date.now()
		let count
		try {
			count = (await this.request(BROADCAST, CMD.ENUM, [0], { timeout: 200 }))[0] ?? 0
		} catch (e) {
			if (!(e instanceof ChainTimeout)) throw e
			this.#rescanWanted = true
			// one lost reply is not an empty bus
			if (++this.#enumFailures < 2 && this.devices.length) return
			this.#setStatus('no-reply', 'No Chain unit answers on this port. Check wiring (swap TX/RX) and power.')
			this.#replaceDevices([])
			return
		}
		this.#enumFailures = 0
		if (!full && count === this.devices.length) return
		this.#rescanWanted = false

		/** @type {ChainDevice[]} */
		const found = []
		const seen = new Map()
		for (let index = 1; index <= count; index++) {
			const t = await this.request(index, CMD.TYPE, [], { timeout: 100 })
			const type = typeFromCode(t.length >= 2 ? t.readUInt16LE(0) : (t[0] ?? 0))
			let uid = ''
			try {
				const u = await this.request(index, CMD.UID, [0], { timeout: 100 })
				if (u[0] === 1 && u.length >= 5) uid = u.subarray(1, 5).toString('hex')
			} catch (e) {
				if (!(e instanceof ChainTimeout)) throw e
			}
			let fw = 0
			try {
				fw = (await this.request(index, CMD.FW_VERSION, [], { timeout: 100 }))[0] ?? 0
			} catch (e) {
				if (!(e instanceof ChainTimeout)) throw e
			}
			const n = (seen.get(type.name) ?? 0) + 1
			seen.set(type.name, n)
			const prev = this.devices.find((d) => (uid ? d.uid === uid : d.index === index && d.type === type))
			found.push({
				index,
				type,
				uid,
				fw,
				key: uid ? `${type.name}-${uid}` : `${type.name}-pos${index}`,
				state: prev?.state ?? {},
			})
		}
		for (const dev of found) await this.#enableReports(dev)
		this.#replaceDevices(found)
		this.#setStatus(found.length ? 'ok' : 'empty', found.length ? `${found.length} Chain units` : 'Chain bus is empty')
	}

	/** Ask units with buttons or switches to send click/edge events on their own. @param {ChainDevice} dev */
	async #enableReports(dev) {
		/** @type {Record<string, number>} */
		const reportCmd = { key: 0xe4, encoder: 0xe4, joystick: 0xe4, pedal: 0xe5, switch: 0xe1, pir: 0xe1 }
		const cmd = reportCmd[dev.type.name]
		if (cmd === undefined) return
		try {
			await this.request(dev.index, cmd, [1], { timeout: 100 })
		} catch (e) {
			if (!(e instanceof ChainTimeout)) throw e
		}
	}

	/** @param {ChainDevice[]} found */
	#replaceDevices(found) {
		const oldKeys = new Set(this.devices.map((d) => d.key))
		const newKeys = new Set(found.map((d) => d.key))
		const added = found.filter((d) => !oldKeys.has(d.key))
		const removed = this.devices.filter((d) => !newKeys.has(d.key))
		const moved = found.some((d) => this.devices.find((o) => o.key === d.key && o.index !== d.index))
		this.devices = found
		if (added.length || removed.length || moved) this.emit('devices', found, added, removed)
	}

	async #pollAll() {
		for (const dev of this.devices) {
			for (const poll of dev.type.polls) {
				if (!this.#running) return
				const data = await this.request(dev.index, poll.cmd, poll.data ?? [])
				/** @type {DeviceState} */
				const next = {}
				poll.decode(data, next)
				this.#applyState(dev, next)
			}
		}
		if (this.devices.length) this.#setStatus('ok', `${this.devices.length} Chain units`)
	}
}
