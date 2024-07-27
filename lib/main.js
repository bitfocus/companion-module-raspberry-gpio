// @ts-check
import { InstanceBase, InstanceStatus, combineRgb, runEntrypoint } from '@companion-module/base'
import { Gpio } from 'onoff'
import * as fs from 'fs'
import { getConfigFields } from './config.js'

/**
 * @typedef {'HIGH' | 'LOW' | null} PinState
 */

class GpioInstance extends InstanceBase {
	/**
	 * Pins setup for output
	 * @type {number[]}
	 */
	active_output_pins = []
	/**
	 * Pins setup for output
	 * @type {import('@companion-module/base').DropdownChoice[]}
	 */
	all_active_output_pins_to_display = []

	/**
	 * All pins in use
	 * @type {number[]}
	 */
	all_active_pin_nums = []

	/**
	 * All pins in use
	 * @type {import('@companion-module/base').DropdownChoice[]}
	 */
	all_active_pin_nums_to_display = []

	/**
	 * Pins setup for input with trigger
	 * @type {number[]}
	 */
	active_input_pins_with_trigger = []

	/**
	 * Pins setup for input
	 * @type {Map<number, { trigger_type: string, debounce_enable: boolean, debounce_time: number, invert_values: boolean }>}
	 */
	active_input_pins = new Map()

	/**
	 * Gpio handles for input pins
	 * @type {Map<number, Gpio>}
	 */
	active_input_pin_objects = new Map()
	/**
	 * Gpio handles for output pins
	 * @type {Map<number, Gpio>}
	 */
	active_output_pin_objects = new Map()

	/**
	 * Active pin states
	 * @type {Map<number, PinState>}
	 */
	all_active_pin_states = new Map()

	constructor(internal) {
		super(internal)
		// get base offset
		this.base = this.getBaseOffset()
	}

	/**
	 * Get Base Pin Offset from system
	 *
	 */
	getBaseOffset() {
		const GpioFolder = '/sys/class/gpio'
		const readFileLines = (path) => fs.readFileSync(path, { encoding: 'utf8' }).toString().split('\n')

		let base = 0
		let which
		const files = fs.readdirSync(GpioFolder)
		files.forEach((file) => {
			if (file.match(/^gpiochip/)) {
				const lines = readFileLines(`${GpioFolder}/${file}/label`)
				if (lines[0].match(/^pinctrl/)) {
					which = file
				}
			}
		})

		if (which) {
			const lines = readFileLines(`${GpioFolder}/${which}/base`)
			base = parseInt(lines[0])
		}
		console.log(which, base)

		return base
	}

	getConfigFields() {
		console.log('Generating config fields...')
		return getConfigFields(this)
	}

	async init(config) {
		if (!config.base) {
			config.base = this.getBaseOffset()
		}

		this.config = config

		if (Gpio.accessible) {
			this.log('debug', `GPIO is accessible (base at ${this.config.base})`)
			this.updateStatus(InstanceStatus.Ok)
		} else {
			this.log('error', 'GPIO is inaccessible')
			this.updateStatus(InstanceStatus.ConnectionFailure, 'GPIO is inaccessible')
			return
		}

		this.processConfig()
		this.setupGPIO()
		this.poll_for_all_active_pin_states()
		this.start_polling_for_states()
		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.initPresets()
		this.updateVariables()
	}

	async configUpdated(config) {
		await this.destroy()
		await this.init(config)
	}

	async destroy() {
		this.stop_polling_for_states()

		for (const output of this.active_output_pin_objects.values()) {
			output.unexport()
		}
		this.active_output_pin_objects.clear()

		for (const input of this.active_input_pin_objects.values()) {
			input.unexport()
		}
		this.active_input_pin_objects.clear()
	}

	initActions() {
		this.log('info', 'Initialising actions')

		const defaultOutputPinId = this.all_active_output_pins_to_display[0]?.id

		this.setActionDefinitions({
			set_pin_low: {
				name: 'Set pin LOW (eg. 0)',
				options: [
					{
						type: 'dropdown',
						label: 'Pin number',
						id: 'pin_to_set_low',
						default: defaultOutputPinId,
						choices: this.all_active_output_pins_to_display,
					},
				],
				callback: async (action) => {
					const pinNumber = Number(action.options.pin_to_set_low)
					this.log('info', `Setting pin ${pinNumber} to LOW (0)`)
					if (isNaN(pinNumber)) return

					await this.#setPinToState(pinNumber, 'LOW')
				},
			},
			set_pin_high: {
				name: 'Set pin HIGH (eg. 1)',
				options: [
					{
						type: 'dropdown',
						label: 'Pin number',
						id: 'pin_to_set_high',
						default: defaultOutputPinId,
						choices: this.all_active_output_pins_to_display,
					},
				],
				callback: async (action) => {
					let pinNumber = Number(action.options.pin_to_set_high)
					this.log('info', `Setting pin ${pinNumber} to HIGH (1)`)
					if (isNaN(pinNumber)) return

					await this.#setPinToState(pinNumber, 'HIGH')
				},
			},
		})
	}

	initPresets() {
		this.log('info', 'Initialising presets')

		/** @type {import('@companion-module/base').CompanionPresetDefinitions} */
		const presetDefinitions = {}

		for (const pinNumber of this.active_output_pins) {
			presetDefinitions[`set_high_${pinNumber}`] = {
				type: 'button',
				category: 'Set GPIO Pin HIGH',
				name: `Set GPIO pin ${pinNumber} HIGH`,
				style: {
					text: `PIN ${pinNumber} HIGH`,
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: 0,
				},
				steps: [
					{
						down: [
							{
								actionId: 'set_pin_high',
								options: {
									pin_to_set_high: pinNumber,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'pin_state_feedback',
						options: {
							bg_high: combineRgb(0, 255, 0),
							bg_low: combineRgb(255, 0, 0),
							gpio_pin_number: pinNumber,
						},
					},
				],
			}
			presetDefinitions[`set_low_${pinNumber}`] = {
				type: 'button',
				category: 'Set GPIO Pin LOW',
				name: `Set GPIO pin ${pinNumber} LOW`,
				style: {
					text: `PIN ${pinNumber} LOW`,
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: 0,
				},
				steps: [
					{
						down: [
							{
								actionId: 'set_pin_low',
								options: {
									pin_to_set_low: pinNumber,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'pin_state_feedback',
						options: {
							bg_high: combineRgb(0, 255, 0),
							bg_low: combineRgb(255, 0, 0),
							gpio_pin_number: pinNumber,
						},
					},
				],
			}

			presetDefinitions[`set_pushbutton_${pinNumber}`] = {
				type: 'button',
				category: 'GPIO Pin pushbutton',
				name: `GPIO pin ${pinNumber} pushbutton`,
				style: {
					text: `PIN ${pinNumber} PUSH`,
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: 0,
				},
				steps: [
					{
						down: [
							{
								actionId: 'set_pin_high',
								options: {
									pin_to_set_high: pinNumber,
								},
							},
						],
						up: [
							{
								actionId: 'set_pin_low',
								options: {
									pin_to_set_low: pinNumber,
								},
							},
						],
					},
				],
				feedbacks: [
					{
						feedbackId: 'pin_state_feedback',
						options: {
							bg_high: combineRgb(0, 255, 0),
							bg_low: combineRgb(255, 0, 0),
							gpio_pin_number: pinNumber,
						},
					},
				],
			}
			presetDefinitions[`set_latch_${pinNumber}`] = {
				type: 'button',
				category: 'GPIO Pin LATCH button',
				name: `GPIO pin ${pinNumber} LATCH button`,
				style: {
					text: `PIN ${pinNumber} LATCH`,
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: 0,
				},
				steps: [
					{
						down: [
							{
								actionId: 'set_pin_high',
								options: {
									pin_to_set_high: pinNumber,
								},
							},
						],
						up: [],
					},
					{
						down: [
							{
								actionId: 'set_pin_low',
								options: {
									pin_to_set_low: pinNumber,
								},
							},
						],
						up: [],
					},
				],

				feedbacks: [
					{
						feedbackId: 'pin_state_feedback',
						options: {
							bg_high: combineRgb(0, 255, 0),
							bg_low: combineRgb(255, 0, 0),
							gpio_pin_number: pinNumber,
						},
					},
				],
			}
		}

		this.setPresetDefinitions(presetDefinitions)
	}

	initFeedbacks() {
		this.log('info', 'Initialising feedbacks')

		const defaultPinId = this.all_active_pin_nums_to_display[0]?.id

		this.setFeedbackDefinitions({
			pin_state_feedback: {
				type: 'advanced',
				name: 'State of GPIO pin (HIGH/LOW)',
				description: 'Feedback showing the state of specified GPIO pin',
				options: [
					{
						type: 'colorpicker',
						label: 'Background color (HIGH/1)',
						id: 'bg_high',
						default: combineRgb(0, 255, 0),
					},
					{
						type: 'colorpicker',
						label: 'Background color (LOW/0)',
						id: 'bg_low',
						default: combineRgb(255, 0, 0),
					},
					{
						type: 'dropdown',
						label: 'Pin number',
						id: 'gpio_pin_number',
						default: defaultPinId,
						choices: this.all_active_pin_nums_to_display,
					},
				],
				callback: (feedback) => {
					const pinState = this.all_active_pin_states.get(Number(feedback.options.gpio_pin_number))
					if (pinState == 'HIGH') {
						return { bgcolor: Number(feedback.options.bg_high) }
					} else if (pinState == 'LOW') {
						return { bgcolor: Number(feedback.options.bg_low) }
					} else {
						return {}
					}
				},
			},
		})
	}

	initVariables() {
		this.log('info', 'Initialising variables')

		/** @type {import('@companion-module/base').CompanionVariableDefinition[]} */
		const variableDefinitions = [{ name: 'Pin Base Offset', variableId: 'base' }]

		for (const pinNumber of this.all_active_pin_nums) {
			variableDefinitions.push({
				name: `GPIO Pin ${pinNumber} state`,
				variableId: `gpio_state_${pinNumber}`,
			})
		}

		this.setVariableDefinitions(variableDefinitions)
		this.setVariableValues({ base: this.config.base })
	}

	updateVariables() {
		/** @type {import('@companion-module/base').CompanionVariableValues} */
		const newValues = {}
		for (const [key, pin_state] of this.all_active_pin_states) {
			newValues[`gpio_state_${key}`] = pin_state ?? ''
		}

		this.setVariableValues(newValues)
	}

	processConfig() {
		this.log('info', 'Processing config')
		this.active_output_pins = []
		this.all_active_output_pins_to_display = []
		this.all_active_pin_nums = []
		this.active_input_pins_with_trigger = []
		this.active_input_pins.clear()

		this.all_active_pin_states.clear()

		for (let pinNumber = 0; pinNumber <= 27; pinNumber++) {
			if (this.config[`use_gpio_${pinNumber}`]) {
				let type = this.config[`gpio_in_out_${pinNumber}`]
				let trigger_type = this.config[`gpio_trigger_type_${pinNumber}`]
				let debounce_enable = this.config[`gpio_enable_debounce_${pinNumber}`]
				let debounce_time = this.config[`gpio_debounce_time_${pinNumber}`]
				let invert_values = this.config[`gpio_invert_values_${pinNumber}`]

				this.all_active_pin_nums.push(pinNumber)
				this.all_active_pin_states.set(pinNumber, null)

				if (type == 'out') {
					this.active_output_pins.push(pinNumber)
					this.all_active_output_pins_to_display.push({ id: pinNumber, label: String(pinNumber) })
				} else if (type == 'in') {
					this.active_input_pins.set(pinNumber, {
						trigger_type: trigger_type,
						debounce_enable: debounce_enable,
						debounce_time: debounce_time,
						invert_values: invert_values,
					})
					if (trigger_type != 'none') {
						this.active_input_pins_with_trigger.push(pinNumber)
					}
				}
			}
		}

		this.all_active_pin_nums_to_display = []

		for (const pin_num of this.all_active_pin_nums) {
			this.all_active_pin_nums_to_display.push({ id: pin_num, label: String(pin_num) })
		}

		console.log(this.active_output_pins)
		console.log(this.active_input_pins)
		console.log(this.all_active_pin_nums_to_display)
	}

	setupGPIO() {
		this.log('info', 'Setting up GPIO')

		for (const pinNumber of this.active_output_pins) {
			const apiPin = pinNumber + this.config.base
			console.log(`Pin_num: ${pinNumber}(${apiPin}) OUTPUT`)
			try {
				this.active_output_pin_objects.set(pinNumber, new Gpio(apiPin, 'out'))
			} catch (err) {
				this.log('error', `GPIO Output pin ${pinNumber} is inaccessible`)
				this.updateStatus(InstanceStatus.ConnectionFailure, `Pin ${pinNumber} is inaccessible\n` + err.toString())
			}
		}

		for (const [pinNumber, config] of this.active_input_pins.entries()) {
			const debounce_enable = config.debounce_enable
			/** @type {any} */ // TODO hack
			const trigger_type = config.trigger_type
			const debounce_time = config.debounce_time
			const invert_values = config.invert_values
			const apiPin = pinNumber + this.config.base

			console.log(`Pin_num: ${pinNumber}(${apiPin}) INPUT`)
			console.log(`Trigger_type: ${trigger_type}`)
			console.log(`Debounce_enable: ${debounce_enable}`)
			console.log(`Debounce_time: ${debounce_time}`)
			console.log(`Invert_values: ${invert_values}`)

			try {
				const gpioHandle = new Gpio(apiPin, 'in', trigger_type, {
					debounceTimeout: debounce_enable ? debounce_time : undefined,
					activeLow: invert_values,
				})

				this.active_input_pin_objects.set(pinNumber, gpioHandle)
			} catch (err) {
				this.log('error', `GPIO Input pin ${pinNumber} is inaccessible`)
				this.updateStatus(InstanceStatus.ConnectionFailure, `Pin ${pinNumber} is inaccessible\n` + err.toString())
			}
		}
		this.log('info','GPIO Setup complete')
	}

	/**
	 * Set a Gpio pin to a state
	 * @param {number} pinNumber
	 * @param {'HIGH' | 'LOW'} value
	 */
	async #setPinToState(pinNumber, value) {
		const gpioHandle = this.active_output_pin_objects.get(pinNumber)
		if (!gpioHandle) return

		switch (value) {
			case 'HIGH':
				await gpioHandle.write(1)
				break

			case 'LOW':
				await gpioHandle.write(0)
				break
		}

		const pinState = this.poll_for_pin_state(pinNumber)
		this.all_active_pin_states.set(pinNumber, pinState)

		this.checkFeedbacks('pin_state_feedback')
		this.updateVariables()
	}

	/**
	 *
	 * @param {number} pinNumber
	 * @returns {PinState}
	 */
	poll_for_pin_state(pinNumber) {
		const gpioHandle = this.active_output_pin_objects.get(pinNumber) ?? this.active_input_pin_objects.get(pinNumber)
		if (!gpioHandle) return null

		const state = gpioHandle.readSync()

		switch (state) {
			case 0:
				return 'LOW'
			case 1:
				return 'HIGH'
			default:
				return null
		}
	}
	poll_for_all_active_pin_states() {
		for (const pinNumber of this.all_active_pin_states.keys()) {
			const pinState = this.poll_for_pin_state(pinNumber)
			this.all_active_pin_states.set(pinNumber, pinState)
		}

		this.checkFeedbacks('pin_state_feedback')
		this.updateVariables()
	}

	start_polling_for_states() {
		this.log('info', 'Started polling regularly')
		this.states_poller = setInterval(this.poll_for_all_active_pin_states.bind(this), this.config.refresh_interval)

		console.log(this.active_input_pins_with_trigger)
		for (const pinNumber of this.active_input_pins_with_trigger) {
			const gpioHandle = this.active_input_pin_objects.get(pinNumber)
			if (!gpioHandle) continue

			gpioHandle.watch((err, value) => {
				if (err) {
					this.log('error', 'Problem on interrupt handler')
					throw err
				}

				this.log('info', 'Registering interrupt, refreshing all GPIO Pin states')

				this.poll_for_all_active_pin_states()
			})
		}
	}

	stop_polling_for_states() {
		if (this.states_poller) {
			clearInterval(this.states_poller)
			delete this.states_poller
		}
	}
}

runEntrypoint(GpioInstance, [])
