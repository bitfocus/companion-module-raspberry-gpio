// @ts-check
// Patches in the module: route a Chain unit to a fixed button (Companion HTTP API), to a key
// of the Chain surface, or to a turn value this module keeps.
import { locationCall } from './companion-http.js'
import { CHAIN_ON, compare, compareOptions, safeId, visible } from './index.js'
import { PatchEngine } from './patches.js'

/**
 * @typedef {import('./index.js').ChainManager} ChainManager
 * @typedef {import('./patches.js').Patch} Patch
 * @typedef {import('./patches.js').PatchTarget} PatchTarget
 * @typedef {import('./index.js').ConfigField} ConfigField
 */

export const MAX_PATCHES = 32

/** @implements {import('./index.js').ChainExtension} */
export class ChainPatches {
	#m
	/** @type {PatchEngine | null} */
	#engine = null
	/** @type {Map<string, { value: number, min: number, max: number, step: number }>} */
	#values = new Map()
	/** @type {Map<string, Promise<void>>} */
	#httpChains = new Map()
	#lastHttpError = 0

	/** @param {ChainManager} m */
	constructor(m) {
		this.#m = m
	}

	get #config() {
		return this.#m.config
	}

	start() {
		this.#rebuild()
	}

	stop() {
		this.#engine?.stop()
		this.#engine = null
	}

	onDevices() {
		this.#rebuild()
	}

	/** @param {import('./bus.js').ChainDevice} dev @param {any} _view @param {Record<string, number|string>} changes */
	onState(dev, _view, changes) {
		this.#engine?.onState(dev.key, changes, dev.state)
	}

	/** @returns {Patch[]} */
	list() {
		const c = this.#config
		const count = Math.max(0, Math.min(MAX_PATCHES, Number(c.patch_count) || 0))
		/** @type {Patch[]} */
		const out = []
		for (let n = 0; n < count; n++) {
			const g = (/** @type {string} */ f) => c[`p${n}_${f}`]
			if (!g('device')) continue
			const kind = g('target') || 'location'
			/** @type {PatchTarget} */
			const target =
				kind === 'surface'
					? { kind, key: Math.max(1, Number(g('slot')) || 1) - 1 }
					: kind === 'value'
						? { kind, name: safeId(String(g('vname') || `patch${n + 1}`)) }
						: {
								kind: 'location',
								page: Number(g('page')) || 1,
								row: Number(g('row')) || 0,
								column: Number(g('column')) || 0,
							}
			out.push({
				n,
				input: g('input') || 'turn',
				device: g('device'),
				device2: g('device2') || undefined,
				action: g('action') === 'press' ? 'press' : 'turn',
				direction: Number(g('direction')) === -1 ? -1 : 1,
				invert: !!g('invert'),
				threshold: Number(g('threshold') ?? 30),
				repeatMs: Number(g('repeat') ?? 150),
				divider: Number(g('divider') || 64),
				target,
			})
			if (target.kind === 'value') {
				const min = Number(g('vmin') ?? 0)
				const max = Number(g('vmax') ?? 100)
				const prev = this.#values.get(target.name)
				const value = Math.min(Math.max(prev ? prev.value : 0, Math.min(min, max)), Math.max(min, max))
				this.#values.set(target.name, { value, min, max, step: Number(g('vstep') ?? 1) })
			}
		}
		return out
	}

	#rebuild() {
		this.#engine?.stop()
		this.#engine = new PatchEngine(this.list(), {
			turn: (t, steps) => this.#turn(t, steps),
			press: (t, down) => this.#press(t, down),
		})
	}

	/** @param {PatchTarget} t @param {number} steps */
	#turn(t, steps) {
		if (!steps) return
		if (t.kind === 'value') return this.adjust(t.name, steps)
		if (t.kind === 'surface') return this.#m.surface?.keyRotate(t.key, steps)
		const what = steps > 0 ? 'rotate-right' : 'rotate-left'
		for (let i = 0; i < Math.min(Math.abs(steps), 50); i++) this.#http(t, what)
	}

	/** @param {PatchTarget} t @param {boolean} down */
	#press(t, down) {
		if (t.kind === 'surface') return this.#m.surface?.keyPress(t.key, down)
		if (t.kind === 'location') return this.#http(t, down ? 'down' : 'up')
		if (t.kind === 'value' && down) return this.adjust(t.name, 1)
	}

	/**
	 * Calls to one button go out in order, one at a time.
	 * @param {{ page: number, row: number, column: number }} loc @param {any} what
	 */
	#http(loc, what) {
		const key = `${loc.page}/${loc.row}/${loc.column}`
		const conn = { host: this.#config.http_host || '127.0.0.1', port: Number(this.#config.http_port) || 8000 }
		const next = (this.#httpChains.get(key) ?? Promise.resolve())
			.then(() => locationCall(conn, loc, what))
			.catch((e) => {
				if (Date.now() - this.#lastHttpError > 5000) {
					this.#lastHttpError = Date.now()
					this.#m.self.log('warn', `Companion HTTP API: ${e?.message ?? e}`)
				}
			})
		this.#httpChains.set(key, next)
		next.finally(() => this.#httpChains.get(key) === next && this.#httpChains.delete(key))
	}

	/** @param {string} name @param {number} steps */
	adjust(name, steps) {
		const v = this.#values.get(name)
		if (v) this.set(name, v.value + steps * v.step)
	}

	/** @param {string} name @param {number} value */
	set(name, value) {
		const v = this.#values.get(name)
		if (!v) return
		const lo = Math.min(v.min, v.max)
		const hi = Math.max(v.min, v.max)
		v.value = Math.round(Math.min(hi, Math.max(lo, value)) * 1000) / 1000
		this.#m.self.setVariableValues({ [`value_${name}`]: v.value })
		this.#m.self.checkFeedbacks('chain_turn_value')
	}

	variables() {
		this.list()
		const defs = [...this.#values.keys()].map((name) => ({
			variableId: `value_${name}`,
			name: `Chain turn value ${name}`,
		}))
		this.#m.self.setVariableValues(Object.fromEntries([...this.#values].map(([k, v]) => [`value_${k}`, v.value])))
		return defs
	}

	/** @returns {import('@companion-module/base').CompanionActionDefinitions} */
	actions() {
		const values = [...this.#values.keys()].map((id) => ({ id, label: id }))
		return {
			chain_value: {
				name: 'Chain: set or adjust a turn value',
				options: [
					{ type: 'dropdown', id: 'name', label: 'Value', default: values[0]?.id ?? '', choices: values },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Mode',
						default: 'set',
						choices: [
							{ id: 'set', label: 'Set to' },
							{ id: 'adjust', label: 'Adjust by steps' },
						],
					},
					{ type: 'number', id: 'amount', label: 'Amount', default: 0, min: -1e9, max: 1e9 },
				],
				callback: (ev) => {
					const name = String(ev.options.name)
					if (ev.options.mode === 'adjust') this.adjust(name, Number(ev.options.amount))
					else this.set(name, Number(ev.options.amount))
				},
			},
		}
	}

	/** @returns {import('@companion-module/base').CompanionFeedbackDefinitions} */
	feedbacks() {
		const values = [...this.#values.keys()].map((id) => ({ id, label: id }))
		return {
			chain_turn_value: {
				type: 'boolean',
				name: 'Chain: turn value compare',
				defaultStyle: { bgcolor: 0x00a000, color: 0xffffff },
				options: [
					{ type: 'dropdown', id: 'name', label: 'Value', default: values[0]?.id ?? '', choices: values },
					...compareOptions(),
				],
				callback: (fb) => compare(this.#values.get(String(fb.options.name))?.value, fb.options),
			},
		}
	}

	/** @returns {ConfigField[]} */
	configFields() {
		const on = CHAIN_ON
		const devices = this.#m.deviceChoices()
		/** @type {ConfigField[]} */
		const f = [
			{
				type: 'static-text',
				id: 'patch_hdr',
				width: 12,
				label: 'Patches',
				value:
					'Route a unit to a button somewhere else: an encoder or knob turns it, a joystick axis or two keys turn it left and right, a key presses it. Targets: a fixed page/row/column (through the Companion HTTP API, works without the surface), a key of the Chain surface (follows its page), or a turn value kept by this module. Turning needs "Enable rotary actions" on the target button.',
				...visible(on),
			},
			{
				type: 'textinput',
				id: 'http_host',
				label: 'Companion HTTP host',
				width: 4,
				default: '127.0.0.1',
				...visible(on),
			},
			{
				type: 'number',
				id: 'http_port',
				label: 'Companion HTTP port',
				width: 4,
				default: 8000,
				min: 1,
				max: 65535,
				...visible(on),
			},
			{
				type: 'number',
				id: 'patch_count',
				label: 'Number of patches (save to add fields)',
				width: 4,
				default: 0,
				min: 0,
				max: MAX_PATCHES,
				...visible(on),
			},
		]
		const count = Math.max(0, Math.min(MAX_PATCHES, Number(this.#config.patch_count) || 0))
		for (let n = 0; n < count; n++) f.push(...patchFields(n, devices))
		return f
	}
}

/**
 * @param {number} n
 * @param {import('@companion-module/base').DropdownChoice[]} devices
 * @returns {ConfigField[]}
 */
function patchFields(n, devices) {
	const on = CHAIN_ON
	const id = (/** @type {string} */ s) => `p${n}_${s}`
	const opt = (/** @type {string} */ s) => `$(options:${id(s)})`
	const when = (/** @type {string} */ expr) => visible(`${on} && ${expr}`)
	const isTarget = (/** @type {string} */ t) => when(`${opt('target')} == '${t}'`)
	return [
		{ type: 'static-text', id: id('hdr'), width: 12, label: `Patch ${n + 1}`, value: '', ...visible(on) },
		{
			type: 'dropdown',
			id: id('device'),
			label: 'Unit',
			width: 3,
			default: devices[0]?.id ?? '',
			choices: devices,
			...visible(on),
		},
		{
			type: 'dropdown',
			id: id('input'),
			label: 'Input',
			width: 3,
			default: 'turn',
			choices: [
				{ id: 'turn', label: 'Turn (encoder, angle, slider)' },
				{ id: 'x', label: 'Joystick X' },
				{ id: 'y', label: 'Joystick Y' },
				{ id: 'button', label: 'Button' },
				{ id: 'pair', label: 'Two buttons: this one left, second right' },
			],
			...visible(on),
		},
		{
			type: 'dropdown',
			id: id('device2'),
			label: 'Second button (turns right)',
			width: 3,
			default: devices[1]?.id ?? '',
			choices: devices,
			...when(`${opt('input')} == 'pair'`),
		},
		{
			type: 'dropdown',
			id: id('action'),
			label: 'Does',
			width: 3,
			default: 'turn',
			choices: [
				{ id: 'turn', label: 'Turn the target' },
				{ id: 'press', label: 'Press the target' },
			],
			...when(`${opt('input')} != 'turn'`),
		},
		{
			type: 'dropdown',
			id: id('direction'),
			label: 'Direction',
			width: 3,
			default: 1,
			choices: [
				{ id: 1, label: 'Right' },
				{ id: -1, label: 'Left' },
			],
			...when(`${opt('input')} == 'button' && ${opt('action')} == 'turn'`),
		},
		{
			type: 'number',
			id: id('threshold'),
			label: 'Dead zone (%)',
			width: 2,
			default: 30,
			min: 1,
			max: 95,
			...when(`(${opt('input')} == 'x' || ${opt('input')} == 'y')`),
		},
		{
			type: 'number',
			id: id('repeat'),
			label: 'Repeat while held (ms, 0 = off)',
			width: 2,
			default: 150,
			min: 0,
			max: 5000,
			...when(`${opt('input')} != 'turn' && ${opt('action')} == 'turn'`),
		},
		{
			type: 'number',
			id: id('divider'),
			label: 'Angle/slider raw units per step',
			width: 2,
			default: 64,
			min: 1,
			max: 4095,
			...when(`${opt('input')} == 'turn'`),
		},
		{ type: 'checkbox', id: id('invert'), label: 'Invert', width: 2, default: false, ...visible(on) },
		{
			type: 'dropdown',
			id: id('target'),
			label: 'Target',
			width: 3,
			default: 'location',
			choices: [
				{ id: 'location', label: 'Button at page/row/column' },
				{ id: 'surface', label: 'Key on the Chain surface' },
				{ id: 'value', label: 'Turn value in this module' },
			],
			...visible(on),
		},
		{ type: 'number', id: id('page'), label: 'Page', width: 2, default: 1, min: 1, max: 999, ...isTarget('location') },
		{ type: 'number', id: id('row'), label: 'Row', width: 2, default: 0, min: 0, max: 99, ...isTarget('location') },
		{
			type: 'number',
			id: id('column'),
			label: 'Column',
			width: 2,
			default: 0,
			min: 0,
			max: 99,
			...isTarget('location'),
		},
		{
			type: 'number',
			id: id('slot'),
			label: 'Surface key',
			width: 2,
			default: 1,
			min: 1,
			max: 64,
			...isTarget('surface'),
		},
		{
			type: 'textinput',
			id: id('vname'),
			label: 'Value name',
			width: 3,
			default: `patch${n + 1}`,
			...isTarget('value'),
		},
		{ type: 'number', id: id('vmin'), label: 'Min', width: 2, default: 0, min: -1e9, max: 1e9, ...isTarget('value') },
		{ type: 'number', id: id('vmax'), label: 'Max', width: 2, default: 100, min: -1e9, max: 1e9, ...isTarget('value') },
		{ type: 'number', id: id('vstep'), label: 'Step', width: 2, default: 1, min: -1e9, max: 1e9, ...isTarget('value') },
	]
}
