// @ts-check
// The Chain as a Companion surface: each unit gets a key, buttons press it, encoders and
// knobs turn it, and the unit LED takes the key colour. The surface follows whatever page
// Companion puts it on.
import * as os from 'node:os'
import { SatelliteClient } from './satellite.js'
import { CHAIN_ON, safeId, visible } from './index.js'

/**
 * @typedef {import('./index.js').ChainManager} ChainManager
 * @typedef {import('./index.js').DeviceView} DeviceView
 * @typedef {import('./bus.js').ChainDevice} ChainDevice
 */

const SURFACE_TYPES = new Set(['key', 'encoder', 'joystick', 'pedal', 'angle', 'switch'])

/** @implements {import('./index.js').ChainExtension} */
export class ChainSurface {
	#m
	/** @type {SatelliteClient | null} */
	#sat = null
	/** @type {Map<number, [number, number, number]>} */
	#slotColors = new Map()
	/** @type {Map<string, { last: number, acc: number }>} */
	#knobs = new Map()
	/** @type {Map<string, boolean>} */
	#pressed = new Map()

	/** @param {ChainManager} m */
	constructor(m) {
		this.#m = m
		m.surface = this
	}

	get #config() {
		return this.#m.config
	}

	/** Surface key (1-based, 0 = none) for every known unit. @returns {Map<string, number>} */
	slots() {
		const out = new Map()
		let auto = 0
		for (const v of this.#m.views()) {
			const a = SURFACE_TYPES.has(v.type) ? ++auto : 0
			const cfg = this.#config[`dev_${safeId(v.key)}_slot`]
			out.set(v.key, cfg === undefined || cfg === '' ? a : Number(cfg))
		}
		return out
	}

	start() {
		if (!this.#config.sat_enable) return
		const { total, perRow } = this.#size()
		const label = safeId(this.#m.self.label || 'chain')
		const sat = new SatelliteClient({
			host: this.#config.sat_host || '127.0.0.1',
			port: Number(this.#config.sat_port) || 16622,
			deviceId: `chain-${os.hostname()}-${label}`.replace(/[^A-Za-z0-9_-]/g, '-'),
			productName: this.#config.sat_name || 'M5Stack Chain',
			keysTotal: total,
			keysPerRow: perRow,
		})
		this.#sat = sat
		sat.on('log', (level, msg) => this.#m.self.log(level, msg))
		sat.on('connected', () => this.#m.self.setVariableValues({ surface_connected: 1 }))
		sat.on('disconnected', () => this.#m.self.setVariableValues({ surface_connected: 0 }))
		sat.on('key-state', (key, rgb) => rgb && this.#keyColour(key + 1, rgb))
		sat.start()
	}

	stop() {
		this.#sat?.stop()
		this.#sat = null
		this.#slotColors.clear()
		this.#knobs.clear()
		this.#pressed.clear()
	}

	/** @param {number} key 0-based @param {boolean} down */
	keyPress(key, down) {
		this.#sat?.keyPress(key, down)
	}

	/** @param {number} key 0-based @param {number} steps */
	keyRotate(key, steps) {
		this.#sat?.keyRotate(key, steps)
	}

	/** @param {ChainDevice[]} _devices @param {ChainDevice[]} added */
	onDevices(_devices, added) {
		if (this.#sat) {
			const { total, perRow } = this.#size()
			this.#sat.resize(total, perRow)
		}
		// put LEDs back on units that came (back) onto the surface
		const slots = this.slots()
		for (const d of added) {
			const c = this.#ledFollows(d.key) ? this.#slotColors.get(slots.get(d.key) ?? 0) : undefined
			if (c && this.#m.bus) this.#m.bus.setLed(d, ...c).catch(() => {})
		}
	}

	/** @param {ChainDevice} dev @param {DeviceView} _view @param {Record<string, number|string>} changes */
	onState(dev, _view, changes) {
		const slot = this.slots().get(dev.key) ?? 0
		if (!this.#sat || slot <= 0) return
		if ('pressed' in changes) {
			// the first read is neither a press nor a release
			const was = this.#pressed.get(dev.key)
			this.#pressed.set(dev.key, !!changes.pressed)
			if (was !== undefined || changes.pressed) this.#sat.keyPress(slot - 1, !!changes.pressed)
		}
		if ('delta' in changes) this.#sat.keyRotate(slot - 1, Number(changes.delta))
		if ('raw' in changes) this.#knob(dev.key, slot, Number(changes.raw))
	}

	/** @param {string} key @param {number} slot @param {number} raw */
	#knob(key, slot, raw) {
		const k = this.#knobs.get(key)
		if (!k) {
			this.#knobs.set(key, { last: raw, acc: 0 })
			return
		}
		k.acc += raw - k.last
		k.last = raw
		const div = Math.max(1, Number(this.#config.chain_knob_divider) || 64)
		const steps = Math.trunc(k.acc / div)
		if (steps) {
			k.acc -= steps * div
			this.#sat?.keyRotate(slot - 1, steps)
		}
	}

	/** @param {number} slot @param {[number, number, number]} rgb */
	#keyColour(slot, rgb) {
		const prev = this.#slotColors.get(slot)
		if (prev && prev.join() === rgb.join()) return
		this.#slotColors.set(slot, rgb)
		const bus = this.#m.bus
		if (!bus) return
		for (const [key, s] of this.slots()) {
			const dev = bus.devices.find((d) => d.key === key)
			if (s === slot && dev && this.#ledFollows(key)) bus.setLed(dev, ...rgb).catch(() => {})
		}
	}

	/** @param {string} key */
	#ledFollows(key) {
		return (this.#config[`dev_${safeId(key)}_led`] || 'surface') === 'surface'
	}

	#size() {
		const total = Math.max(1, ...this.slots().values())
		const perRow = Math.max(1, Math.min(total, Number(this.#config.sat_cols) || 8))
		return { total, perRow }
	}

	variables() {
		return [{ variableId: 'surface_connected', name: 'Chain: surface connected to Companion (0/1)' }]
	}

	/** @param {DeviceView} v */
	deviceFields(v) {
		const id = safeId(v.key)
		return /** @type {import('./index.js').ConfigField[]} */ ([
			{
				type: 'number',
				id: `dev_${id}_slot`,
				label: 'Key on the Chain surface (0 = none)',
				width: 4,
				default: this.slots().get(v.key) ?? 0,
				min: 0,
				max: 64,
				...visible(CHAIN_ON),
			},
			{
				type: 'dropdown',
				id: `dev_${id}_led`,
				label: 'LED',
				width: 4,
				default: 'surface',
				choices: [
					{ id: 'surface', label: 'Follows its surface key colour' },
					{ id: 'manual', label: 'Only set by actions' },
				],
				...visible(CHAIN_ON),
			},
		])
	}

	configFields() {
		const on = CHAIN_ON
		return /** @type {import('./index.js').ConfigField[]} */ ([
			{
				type: 'static-text',
				id: 'sat_hdr',
				width: 12,
				label: 'Chain as a Companion surface',
				value:
					'The Chain registers as a surface (Satellite API) so its keys follow whatever page that surface is on, encoders and knobs turn their key, and unit LEDs take the key colour. Choose the page in Surfaces. Turning needs "Enable rotary actions" on the button.',
				...visible(on),
			},
			{ type: 'checkbox', id: 'sat_enable', label: 'Register as a surface', width: 3, default: true, ...visible(on) },
			{ type: 'textinput', id: 'sat_host', label: 'Companion host', width: 3, default: '127.0.0.1', ...visible(on) },
			{
				type: 'number',
				id: 'sat_port',
				label: 'Satellite port',
				width: 2,
				default: 16622,
				min: 1,
				max: 65535,
				...visible(on),
			},
			{ type: 'textinput', id: 'sat_name', label: 'Surface name', width: 2, default: 'M5Stack Chain', ...visible(on) },
			{ type: 'number', id: 'sat_cols', label: 'Keys per row', width: 2, default: 8, min: 1, max: 32, ...visible(on) },
			{
				type: 'number',
				id: 'chain_knob_divider',
				label: 'Angle/slider: raw units per surface step',
				width: 4,
				default: 64,
				min: 1,
				max: 4095,
				...visible(on),
			},
		])
	}
}
