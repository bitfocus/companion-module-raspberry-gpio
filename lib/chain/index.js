// @ts-check
// Glue between a Chain bus and Companion: config fields, variables, actions, feedbacks and
// presets for the units found on it. The surface and patch features plug in as extensions.
import { InstanceStatus, combineRgb, splitRgb } from '@companion-module/base'
import { ChainBus } from './bus.js'
import { SimulatedChain } from './simulator.js'
import { SerialTransport } from './transport.js'
import { CHAIN_TYPES, typeFromName } from './types.js'

/**
 * @typedef {import('./bus.js').ChainDevice} ChainDevice
 * @typedef {import('@companion-module/base').SomeCompanionConfigField} ConfigField
 * @typedef {{ key: string, type: string, uid: string }} KnownDevice
 * @typedef {KnownDevice & { name: string, online: ChainDevice | undefined }} DeviceView
 * @typedef {{
 *   start?(): void,
 *   stop?(): void,
 *   onDevices?(devices: ChainDevice[], added: ChainDevice[], removed: ChainDevice[]): void,
 *   onState?(dev: ChainDevice, view: DeviceView, changes: Record<string, number|string>): void,
 *   configFields?(): ConfigField[],
 *   deviceFields?(view: DeviceView): ConfigField[],
 *   variables?(): import('@companion-module/base').CompanionVariableDefinition[],
 *   actions?(): import('@companion-module/base').CompanionActionDefinitions,
 *   feedbacks?(): import('@companion-module/base').CompanionFeedbackDefinitions,
 * }} ChainExtension
 */

export const SIM_PORT = 'sim'
/** Pi GPIO pins that each serial port takes, so they are not also used as plain GPIO */
export const PORT_PINS = {
	'/dev/serial0': [14, 15],
	'/dev/ttyAMA0': [14, 15],
	'/dev/ttyS0': [14, 15],
}

/** Companion expression that is true while the Chain is on a port that takes GPIO pins */
export function chainPinsExpression() {
	const ports = Object.keys(PORT_PINS)
		.map((p) => `$(options:chain_port) == '${p}'`)
		.join(' || ')
	return `$(options:chain_enable) && (${ports})`
}

/**
 * GPIO pins the Chain takes with this config.
 * @param {any} config
 * @returns {number[]}
 */
export function chainPins(config) {
	if (!config.chain_enable) return []
	return /** @type {Record<string, number[]>} */ (PORT_PINS)[config.chain_port || '/dev/serial0'] ?? []
}

/** @param {string} s */
export const safeId = (s) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_')

/** isVisibleExpression helper for config fields @param {string} expr */
export const visible = (expr) => ({ isVisibleExpression: expr })
export const CHAIN_ON = '$(options:chain_enable)'

export class ChainManager {
	/** @type {import('@companion-module/base').InstanceBase<any>} */
	self
	/** @type {ChainBus | null} */
	bus = null
	/** @type {SimulatedChain | null} */
	sim = null
	/** @type {any} */
	config = {}
	/** @type {ChainExtension[]} */
	extensions
	#onDefinitionsChanged

	/**
	 * @param {import('@companion-module/base').InstanceBase<any>} self
	 * @param {() => void} onDefinitionsChanged
	 * @param {((m: ChainManager) => ChainExtension)[]} [extensions]
	 */
	constructor(self, onDefinitionsChanged, extensions = []) {
		this.self = self
		this.#onDefinitionsChanged = onDefinitionsChanged
		this.extensions = extensions.map((make) => make(this))
	}

	get enabled() {
		return !!this.config.chain_enable
	}

	/** @param {any} config */
	async start(config) {
		this.config = config
		if (!this.enabled) return

		const port = String(config.chain_port || '/dev/serial0')
		/** @type {import('./bus.js').ChainTransport} */
		let transport
		if (port === SIM_PORT) {
			const types = String(config.chain_sim_devices || '')
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s && typeFromName(s.toLowerCase()))
			this.sim = new SimulatedChain(types)
			transport = this.sim
		} else {
			const serial = new SerialTransport(port)
			try {
				await serial.open()
			} catch (e) {
				this.self.updateStatus(InstanceStatus.ConnectionFailure, `Chain port ${port}: ${e?.message ?? e}`)
				this.self.log('error', `Could not open Chain port ${port}: ${e?.message ?? e}`)
				return
			}
			transport = serial
		}

		const bus = new ChainBus(transport, { pollInterval: Number(config.chain_poll_ms) || 20 })
		this.bus = bus
		bus.on('log', (level, msg) => this.self.log(level, msg))
		bus.on('status', (status, msg) => {
			this.self.setVariableValues({ chain_status: status })
			if (status === 'ok' || status === 'empty') this.self.updateStatus(InstanceStatus.Ok, msg)
			else this.self.updateStatus(InstanceStatus.ConnectionFailure, msg)
		})
		bus.on('devices', (devices, added, removed) => this.#onDevices(devices, added, removed))
		bus.on('state', (dev, changes) => this.#onState(dev, changes))

		for (const e of this.extensions) e.start?.()
		bus.start()
	}

	async stop() {
		for (const e of this.extensions) e.stop?.()
		this.bus?.stop()
		this.bus = null
		this.sim = null
	}

	// ---- devices ----

	/** Every unit seen so far, as kept in the config. @returns {KnownDevice[]} */
	known() {
		try {
			const list = JSON.parse(this.config.chain_known || '[]')
			return Array.isArray(list) ? list.filter((d) => d && typeof d.key === 'string') : []
		} catch {
			return []
		}
	}

	/** Known units in first-seen order, with their names and live state. @returns {DeviceView[]} */
	views() {
		const counts = new Map()
		return this.known().map((k) => {
			const n = (counts.get(k.type) ?? 0) + 1
			counts.set(k.type, n)
			const name = safeId(String(this.config[`dev_${safeId(k.key)}_name`] || `${k.type}${n}`))
			return { ...k, name, online: this.bus?.devices.find((d) => d.key === k.key) }
		})
	}

	/** @param {string} key */
	view(key) {
		return this.views().find((v) => v.key === key)
	}

	/** @param {(v: DeviceView) => boolean} [filter] */
	deviceChoices(filter = () => true) {
		return this.views()
			.filter(filter)
			.map((v) => ({ id: v.key, label: `${v.name} (${typeFromName(v.type)?.label ?? v.type})` }))
	}

	/** @param {ChainDevice[]} devices @param {ChainDevice[]} added @param {ChainDevice[]} removed */
	#onDevices(devices, added, removed) {
		const known = this.known()
		const fresh = devices.filter((d) => !known.some((k) => k.key === d.key))
		for (const d of added)
			this.self.log('info', `Chain unit found at position ${d.index}: ${d.type.label} (${d.uid || 'no uid'})`)
		for (const d of removed) this.self.log('info', `Chain unit gone: ${d.type.label} (${d.uid || d.key})`)
		if (fresh.length) {
			const next = [...known, ...fresh.map((d) => ({ key: d.key, type: d.type.name, uid: d.uid }))]
			this.config = { ...this.config, chain_known: JSON.stringify(next) }
			// Persist, so the new units get their own section in the module config
			this.self.saveConfig(this.config)
		}
		this.self.setVariableValues({ chain_count: devices.length })
		for (const e of this.extensions) e.onDevices?.(devices, added, removed)
		this.#onDefinitionsChanged()
		this.#pushAllVariables()
		this.self.checkFeedbacks('chain_online', 'chain_pressed', 'chain_value')
	}

	/** @param {ChainDevice} dev @param {Record<string, number|string>} changes */
	#onState(dev, changes) {
		const v = this.view(dev.key)
		if (!v) return
		/** @type {Record<string, number|string>} */
		const vars = {}
		for (const [k, val] of Object.entries(changes)) vars[`${v.name}_${k}`] = val
		this.self.setVariableValues(vars)
		this.self.checkFeedbacks('chain_pressed', 'chain_value', 'chain_click')
		for (const e of this.extensions) e.onState?.(dev, v, changes)
	}

	#pushAllVariables() {
		/** @type {Record<string, number|string|undefined>} */
		const vars = {}
		for (const v of this.views()) {
			for (const val of typeFromName(v.type)?.values ?? []) vars[`${v.name}_${val.id}`] = v.online?.state[val.id] ?? ''
			vars[`${v.name}_online`] = v.online ? 1 : 0
		}
		this.self.setVariableValues(vars)
	}

	// ---- Companion definitions ----

	/** @returns {import('@companion-module/base').CompanionVariableDefinition[]} */
	variables() {
		if (!this.enabled) return []
		/** @type {import('@companion-module/base').CompanionVariableDefinition[]} */
		const defs = [
			{ variableId: 'chain_status', name: 'Chain: bus status' },
			{ variableId: 'chain_count', name: 'Chain: units on the bus' },
		]
		for (const v of this.views()) {
			defs.push({ variableId: `${v.name}_online`, name: `Chain ${v.name}: online (0/1)` })
			for (const val of typeFromName(v.type)?.values ?? []) {
				defs.push({ variableId: `${v.name}_${val.id}`, name: `Chain ${v.name}: ${val.name}` })
			}
		}
		for (const e of this.extensions) defs.push(...(e.variables?.() ?? []))
		return defs
	}

	/** @returns {import('@companion-module/base').CompanionActionDefinitions} */
	actions() {
		if (!this.enabled) return {}
		const leds = this.deviceChoices((v) => !!typeFromName(v.type)?.led)
		const encoders = this.deviceChoices((v) => v.type === 'encoder')
		/** @type {import('@companion-module/base').CompanionActionDefinitions} */
		const a = {
			chain_led: {
				name: 'Chain: set unit LED',
				options: [
					{ type: 'dropdown', id: 'device', label: 'Unit', default: leds[0]?.id ?? '', choices: leds },
					{ type: 'colorpicker', id: 'color', label: 'Colour', default: combineRgb(255, 255, 255) },
					{ type: 'number', id: 'brightness', label: 'Brightness (%)', default: 100, min: 0, max: 100 },
				],
				callback: async (ev) => {
					const dev = this.bus?.devices.find((d) => d.key === ev.options.device)
					if (!dev || !this.bus) return
					const { r, g, b } = splitRgb(Number(ev.options.color))
					await this.bus.setBrightness(dev, Number(ev.options.brightness)).catch(() => {})
					await this.bus.setLed(dev, r, g, b).catch(() => {})
				},
			},
			chain_encoder_reset: {
				name: 'Chain: reset encoder count',
				options: [
					{ type: 'dropdown', id: 'device', label: 'Encoder', default: encoders[0]?.id ?? '', choices: encoders },
				],
				callback: async (ev) => {
					const dev = this.bus?.devices.find((d) => d.key === ev.options.device)
					if (dev && this.bus) await this.bus.resetEncoder(dev).catch(() => {})
				},
			},
			chain_rescan: {
				name: 'Chain: rescan the bus',
				options: [],
				callback: () => this.bus?.rescan(),
			},
		}
		if (this.sim) Object.assign(a, this.#simActions())
		for (const e of this.extensions) Object.assign(a, e.actions?.() ?? {})
		return a
	}

	/** Actions that operate the simulated units, so the module can be tried without hardware. */
	#simActions() {
		const all = this.deviceChoices()
		/** @type {import('@companion-module/base').CompanionActionDefinitions} */
		return {
			chain_sim: {
				name: 'Chain simulator: operate a unit',
				options: [
					{ type: 'dropdown', id: 'device', label: 'Unit', default: all[0]?.id ?? '', choices: all },
					{
						type: 'dropdown',
						id: 'op',
						label: 'Do',
						default: 'press',
						choices: [
							{ id: 'press', label: 'Press button' },
							{ id: 'release', label: 'Release button' },
							{ id: 'single', label: 'Single click event' },
							{ id: 'turn', label: 'Turn encoder by amount' },
							{ id: 'x', label: 'Joystick X to amount (-127..127)' },
							{ id: 'y', label: 'Joystick Y to amount (-127..127)' },
							{ id: 'knob', label: 'Angle/slider to amount (0..4095)' },
						],
					},
					{ type: 'number', id: 'amount', label: 'Amount', default: 1, min: -4095, max: 4095 },
				],
				callback: (ev) => {
					const dev = this.bus?.devices.find((d) => d.key === ev.options.device)
					const sim = this.sim
					if (!dev || !sim) return
					const n = Number(ev.options.amount)
					const u = sim.unit(dev.index)
					switch (ev.options.op) {
						case 'press':
							return sim.press(dev.index, true)
						case 'release':
							return sim.press(dev.index, false)
						case 'single':
							return sim.click(dev.index, 'single')
						case 'turn':
							return sim.turn(dev.index, n)
						case 'x':
							return sim.stick(dev.index, n, u.y)
						case 'y':
							return sim.stick(dev.index, u.x, n)
						case 'knob':
							return sim.knob(dev.index, n)
					}
				},
			},
			chain_sim_plug: {
				name: 'Chain simulator: plug a unit onto the end',
				options: [
					{
						type: 'dropdown',
						id: 'type',
						label: 'Type',
						default: 'key',
						choices: CHAIN_TYPES.filter((t) => t.polls.length).map((t) => ({ id: t.name, label: t.label })),
					},
				],
				callback: (ev) => void this.sim?.plug(String(ev.options.type)),
			},
		}
	}

	/** @returns {import('@companion-module/base').CompanionFeedbackDefinitions} */
	feedbacks() {
		if (!this.enabled) return {}
		const all = this.deviceChoices()
		const buttons = this.deviceChoices((v) => !!typeFromName(v.type)?.button)
		const valueChoices = []
		for (const v of this.views()) {
			for (const val of typeFromName(v.type)?.values ?? []) {
				if (val.id !== 'click') valueChoices.push({ id: `${v.key}|${val.id}`, label: `${v.name} ${val.name}` })
			}
		}
		const style = { bgcolor: combineRgb(0, 160, 0), color: combineRgb(255, 255, 255) }
		/** @type {import('@companion-module/base').CompanionFeedbackDefinitions} */
		const f = {
			chain_pressed: {
				type: 'boolean',
				name: 'Chain: button held',
				defaultStyle: style,
				options: [{ type: 'dropdown', id: 'device', label: 'Unit', default: buttons[0]?.id ?? '', choices: buttons }],
				callback: (fb) => !!this.bus?.devices.find((d) => d.key === fb.options.device)?.state.pressed,
			},
			chain_click: {
				type: 'boolean',
				name: 'Chain: last click was',
				defaultStyle: style,
				options: [
					{ type: 'dropdown', id: 'device', label: 'Unit', default: buttons[0]?.id ?? '', choices: buttons },
					{
						type: 'dropdown',
						id: 'kind',
						label: 'Click',
						default: 'double',
						choices: ['single', 'double', 'long'].map((id) => ({ id, label: id })),
					},
				],
				callback: (fb) => this.bus?.devices.find((d) => d.key === fb.options.device)?.state.click === fb.options.kind,
			},
			chain_online: {
				type: 'boolean',
				name: 'Chain: unit is connected',
				defaultStyle: style,
				options: [{ type: 'dropdown', id: 'device', label: 'Unit', default: all[0]?.id ?? '', choices: all }],
				callback: (fb) => !!this.bus?.devices.some((d) => d.key === fb.options.device),
			},
			chain_value: {
				type: 'boolean',
				name: 'Chain: unit value compare',
				defaultStyle: style,
				options: [
					{ type: 'dropdown', id: 'value', label: 'Value', default: valueChoices[0]?.id ?? '', choices: valueChoices },
					...compareOptions(),
				],
				callback: (fb) => {
					const [key, id] = String(fb.options.value).split('|')
					return compare(this.bus?.devices.find((d) => d.key === key)?.state[id], fb.options)
				},
			},
		}
		for (const e of this.extensions) Object.assign(f, e.feedbacks?.() ?? {})
		return f
	}

	/** @returns {import('@companion-module/base').CompanionPresetDefinitions} */
	presets() {
		if (!this.enabled) return {}
		/** @type {import('@companion-module/base').CompanionPresetDefinitions} */
		const p = {}
		for (const v of this.views()) {
			const t = typeFromName(v.type)
			if (!t?.values.length) continue
			const shown = t.values.filter((x) => x.id !== 'click').map((x) => `$(${this.self.label}:${v.name}_${x.id})`)
			p[`chain_${safeId(v.key)}`] = {
				type: 'button',
				category: 'Chain units',
				name: `${v.name} live values`,
				style: {
					text: `${v.name}\\n${shown.join('\\n')}`,
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: 0,
				},
				steps: [{ down: [], up: [] }],
				feedbacks: t.button
					? [{ feedbackId: 'chain_pressed', options: { device: v.key }, style: { bgcolor: combineRgb(0, 160, 0) } }]
					: [],
			}
		}
		return p
	}

	/** @returns {ConfigField[]} */
	configFields() {
		const views = this.views()
		const on = CHAIN_ON
		/** @type {ConfigField[]} */
		const f = [
			{
				type: 'static-text',
				id: 'chain_hdr',
				width: 12,
				label: 'M5Stack Chain',
				value:
					'Chain units (Key, Encoder, Joystick, Angle, ...) on a Pi UART. Wiring: Pi pin 8 (GPIO14 TX) and pin 10 (GPIO15 RX) to the two Chain signal wires, pin 2 (5V) and pin 6 (GND) to power. If nothing answers, swap the two signal wires. The UART must be on and the serial console off (raspi-config, Interface options, Serial port: login shell No, hardware Yes). See the help for more.',
			},
			{ type: 'checkbox', id: 'chain_enable', label: 'Use a Chain bus', width: 4, default: false },
			{
				type: 'dropdown',
				id: 'chain_port',
				label: 'Serial port',
				width: 4,
				default: '/dev/serial0',
				allowCustom: true,
				choices: [
					{ id: '/dev/serial0', label: '/dev/serial0 (GPIO14/15, pins 8/10)' },
					{ id: '/dev/ttyAMA0', label: '/dev/ttyAMA0' },
					{ id: '/dev/ttyAMA1', label: '/dev/ttyAMA1' },
					{ id: '/dev/ttyAMA2', label: '/dev/ttyAMA2' },
					{ id: '/dev/ttyAMA3', label: '/dev/ttyAMA3' },
					{ id: '/dev/ttyAMA4', label: '/dev/ttyAMA4' },
					{ id: '/dev/ttyUSB0', label: '/dev/ttyUSB0 (USB serial adapter)' },
					{ id: SIM_PORT, label: 'Simulated Chain (no hardware)' },
				],
				...visible(on),
			},
			{
				type: 'number',
				id: 'chain_poll_ms',
				label: 'Pause between polls (ms)',
				width: 4,
				default: 20,
				min: 0,
				max: 1000,
				...visible(on),
			},
			{
				type: 'textinput',
				id: 'chain_sim_devices',
				label: 'Simulated units, in chain order',
				width: 12,
				default: 'key,key,encoder,joystick,angle',
				...visible(`${on} && $(options:chain_port) == '${SIM_PORT}'`),
			},
			{
				type: 'textinput',
				id: 'chain_known',
				label: 'Known units (kept by the module)',
				width: 12,
				default: '[]',
				...visible('false'),
			},
			{
				type: 'static-text',
				id: 'chain_found',
				width: 12,
				label: 'Units found',
				value: views.length
					? views
							.map(
								(v, i) =>
									`${i + 1}. ${v.name}: ${typeFromName(v.type)?.label ?? v.type}${v.uid ? `, uid ${v.uid}` : ''}, ${v.online ? `connected at position ${v.online.index}` : 'not connected'}`,
							)
							.join('<br/>')
					: 'None yet. Units appear here on their own once the bus sees them (reopen this page to refresh).',
				...visible(on),
			},
			{
				type: 'checkbox',
				id: 'chain_forget',
				label: 'Forget units that are not connected (on save)',
				width: 12,
				default: false,
				...visible(on),
			},
		]

		for (const v of views) {
			const id = safeId(v.key)
			f.push(
				{
					type: 'static-text',
					id: `dev_${id}_hdr`,
					width: 12,
					label: `${typeFromName(v.type)?.label ?? v.type}${v.uid ? ` ${v.uid}` : ''}`,
					value: v.online ? `Connected at position ${v.online.index}` : 'Not connected',
					...visible(on),
				},
				{
					type: 'textinput',
					id: `dev_${id}_name`,
					label: 'Name (variable prefix)',
					width: 4,
					default: v.name,
					...visible(on),
				},
			)
			for (const e of this.extensions) f.push(...(e.deviceFields?.(v) ?? []))
		}
		for (const e of this.extensions) f.push(...(e.configFields?.() ?? []))
		return f
	}

	/**
	 * Tidy a config before use: GPIO pins the Chain port takes are switched off as plain pins,
	 * and units that are not connected are dropped when the user asked for it.
	 * @param {any} config
	 */
	cleanConfig(config) {
		const taken = chainPins(config).filter((pin) => config[`use_gpio_${pin}`])
		if (taken.length) {
			config = { ...config }
			for (const pin of taken) config[`use_gpio_${pin}`] = false
			this.self.log('warn', `GPIO ${taken.join(', ')} switched off as plain pins: the Chain serial port uses them`)
		}
		if (!config.chain_forget) return config
		const online = new Set(this.bus?.devices.map((d) => d.key) ?? [])
		/** @type {KnownDevice[]} */
		let known = []
		try {
			known = JSON.parse(config.chain_known || '[]')
		} catch {
			// start over
		}
		return { ...config, chain_forget: false, chain_known: JSON.stringify(known.filter((k) => online.has(k.key))) }
	}
}

/** Options for a "value is >, <, = than" feedback */
export function compareOptions() {
	return /** @type {import('@companion-module/base').SomeCompanionFeedbackInputField[]} */ ([
		{
			type: 'dropdown',
			id: 'op',
			label: 'Is',
			default: 'gt',
			choices: [
				{ id: 'gt', label: '>' },
				{ id: 'lt', label: '<' },
				{ id: 'eq', label: '=' },
			],
		},
		{ type: 'number', id: 'than', label: 'Than', default: 50, min: -1e9, max: 1e9 },
	])
}

/** @param {unknown} raw @param {any} options */
export function compare(raw, options) {
	if (raw === undefined || raw === '') return false
	const v = Number(raw)
	const than = Number(options.than)
	return options.op === 'lt' ? v < than : options.op === 'eq' ? v === than : v > than
}
