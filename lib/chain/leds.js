// @ts-check
// Who decides each unit's LED colour: a patch shows its target button's colour, a unit on the
// Chain surface shows its key's colour, and every other unit keeps the colour an action gave it.
import { combineRgb, splitRgb } from '@companion-module/base'
import { CHAIN_ON, safeId, visible } from './index.js'
import { typeFromName } from './types.js'

/**
 * @typedef {import('./index.js').ChainManager} ChainManager
 * @typedef {import('./index.js').DeviceView} DeviceView
 * @typedef {[number, number, number]} Rgb
 * @typedef {{ kind: 'patch' | 'surface' | 'free', rgb?: Rgb }} LedSource
 */

/**
 * The ATOM Matrix's "vivid" style for one LED that stands for a whole button: a colourful
 * button colour (saturation >= 0.35, value >= 0.2) is shown at full brightness with its
 * saturation pushed 30 % toward full; a bright grey or white one shows white; a dark one is off.
 * Gamma 2.2 follows, as on the Matrix.
 * @param {Rgb} rgb
 * @returns {Rgb}
 */
export function vivid([r, g, b]) {
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	const v = max / 255
	const s = max ? (max - min) / max : 0
	/** @type {Rgb} */
	let out
	if (s >= 0.35 && v >= 0.2) {
		const s2 = s + (1 - s) * 0.3
		// keep hue, full value, more saturation: scale each channel's distance from max
		out = /** @type {Rgb} */ (
			[r, g, b].map((c) => {
				const dist = s ? (max - c) / (max - min || 1) : 0
				return 255 * (1 - s2 * dist)
			})
		)
	} else if (v >= 0.5) {
		out = [255, 255, 255]
	} else {
		out = [0, 0, 0]
	}
	return /** @type {Rgb} */ (out.map((c) => Math.round(Math.pow(Math.max(0, Math.min(255, c)) / 255, 2.2) * 255)))
}

const SUBSCRIPTIONS_HINT =
	'Patched unit LEDs need button colours from Companion: turn on Settings, Satellite, Button Subscriptions API'

/** @param {number} n */
const subId = (n) => `patch-${n}`

/** @implements {import('./index.js').ChainExtension} */
export class ChainLeds {
	#m
	/** Colours set by actions, kept so they come back when a unit is plugged in again @type {Map<string, Rgb>} */
	#free = new Map()
	/** Colours of patched buttons from Companion, by subscription id @type {Map<string, Rgb>} */
	#subColours = new Map()
	/** What each unit shows now, so the same colour is not sent twice @type {Map<string, string>} */
	#shown = new Map()

	/** @param {ChainManager} m */
	constructor(m) {
		this.#m = m
		m.leds = this
	}

	get #config() {
		return this.#m.config
	}

	/** Patches whose unit LED follows a fixed button. */
	#locationPatches() {
		return (this.#m.patches?.list() ?? []).filter((p) => p.led !== false && p.target.kind === 'location')
	}

	/** A Satellite connection is needed for button colours even without the surface. */
	needsSatellite() {
		return this.#locationPatches().length > 0
	}

	/** Subscribe to the buttons that patched units show. */
	syncSubscriptions() {
		const sat = this.#m.surface?.satellite
		if (!sat) return
		/** @type {Map<string, { page: number, row: number, column: number }>} */
		const wanted = new Map()
		for (const p of this.#locationPatches()) {
			if (p.target.kind === 'location') wanted.set(subId(p.n), p.target)
		}
		for (const id of this.#subColours.keys()) if (!wanted.has(id)) this.#subColours.delete(id)
		sat.setSubscriptions(wanted)
		this.#hintOnce(sat, wanted.size)
	}

	#hinted = false
	/** @param {any} sat @param {number} count */
	#hintOnce(sat, count) {
		if (this.#hinted || !count) return
		if (sat.connected && !sat.canSubscribe) {
			this.#hinted = true
			this.#m.self.log('warn', SUBSCRIPTIONS_HINT)
			return
		}
		sat.once('subscriptions', (/** @type {boolean} */ ok) => {
			if (ok || this.#hinted) return
			this.#hinted = true
			this.#m.self.log('warn', SUBSCRIPTIONS_HINT)
		})
	}

	/** @param {string} id @param {Rgb} rgb */
	subColour(id, rgb) {
		this.#subColours.set(id, rgb)
		this.refresh()
	}

	/**
	 * Where a unit's colour comes from right now.
	 * @param {string} key
	 * @returns {LedSource}
	 */
	source(key) {
		if ((this.#config[`dev_${safeId(key)}_led`] || 'auto') === 'manual')
			return { kind: 'free', rgb: this.#free.get(key) }
		for (const p of this.#m.patches?.list() ?? []) {
			if (p.led === false || (p.device !== key && p.device2 !== key)) continue
			if (p.target.kind === 'location') return { kind: 'patch', rgb: this.#subColours.get(subId(p.n)) }
			if (p.target.kind === 'surface') return { kind: 'patch', rgb: this.#m.surface?.slotColour(p.target.key + 1) }
		}
		const slot = this.#config.sat_enable ? (this.#m.surface?.slots().get(key) ?? 0) : 0
		if (slot > 0) return { kind: 'surface', rgb: this.#m.surface?.slotColour(slot) }
		return { kind: 'free', rgb: this.#free.get(key) }
	}

	/** Bring every connected unit's LED up to date. */
	refresh() {
		const bus = this.#m.bus
		if (!bus) return
		for (const dev of bus.devices) {
			if (!dev.type.led) continue
			const src = this.source(dev.key)
			// followed colours get the Matrix look; colours from actions are shown as picked
			const rgb = src.rgb && src.kind !== 'free' && this.#config.chain_led_style !== 'exact' ? vivid(src.rgb) : src.rgb
			if (!rgb || this.#shown.get(dev.key) === rgb.join()) continue
			this.#shown.set(dev.key, rgb.join())
			bus.setLed(dev, ...rgb).catch(() => this.#shown.delete(dev.key))
		}
	}

	/** @param {any[]} _devices @param {import('./bus.js').ChainDevice[]} added */
	onDevices(_devices, added) {
		// a unit that was unplugged has lost its colour
		for (const d of added) this.#shown.delete(d.key)
		this.syncSubscriptions()
		this.refresh()
	}

	stop() {
		this.#shown.clear()
		this.#subColours.clear()
	}

	/** @returns {import('@companion-module/base').CompanionActionDefinitions} */
	actions() {
		const free = this.#m.deviceChoices((v) => !!typeFromName(v.type)?.led && this.source(v.key).kind === 'free')
		return {
			chain_led_free: {
				name: 'Chain: set the colour of an unpatched unit',
				description:
					'For units whose LED does not follow a patched button or a surface key. The colour is kept and comes back when the unit is plugged in again.',
				options: [
					{ type: 'dropdown', id: 'device', label: 'Unit', default: free[0]?.id ?? '', choices: free },
					{ type: 'colorpicker', id: 'color', label: 'Colour', default: combineRgb(255, 255, 255) },
				],
				callback: (ev) => {
					const key = String(ev.options.device)
					if (this.source(key).kind !== 'free') {
						this.#m.self.log(
							'warn',
							`Chain unit ${this.#m.view(key)?.name ?? key} follows a button, so its colour is not set by actions`,
						)
						return
					}
					const { r, g, b } = splitRgb(Number(ev.options.color))
					this.#free.set(key, [r, g, b])
					this.refresh()
				},
			},
		}
	}

	configFields() {
		return /** @type {import('./index.js').ConfigField[]} */ ([
			{
				type: 'dropdown',
				id: 'chain_led_style',
				label: 'LED colours from buttons',
				width: 6,
				default: 'vivid',
				choices: [
					{ id: 'vivid', label: 'Vivid, like the ATOM Matrix (full brightness, more saturation, gamma)' },
					{ id: 'exact', label: 'Exact button colour' },
				],
				...visible(CHAIN_ON),
			},
		])
	}

	/** @param {DeviceView} v */
	deviceFields(v) {
		if (!typeFromName(v.type)?.led) return []
		return /** @type {import('./index.js').ConfigField[]} */ ([
			{
				type: 'dropdown',
				id: `dev_${safeId(v.key)}_led`,
				label: 'LED',
				width: 4,
				default: 'auto',
				choices: [
					{ id: 'auto', label: 'Patched button colour, else surface key colour, else set by actions' },
					{ id: 'manual', label: 'Set by actions only' },
				],
				...visible(CHAIN_ON),
			},
		])
	}
}
