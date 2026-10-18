// @ts-check
import { PORT_PINS, chainPinsExpression } from './chain/index.js'

/**
 * @returns {import("@companion-module/base").SomeCompanionConfigField[]}
 */
export function getConfigFields(self) {
	/** @type {import("@companion-module/base").SomeCompanionConfigField[]} */
	let configuration_fields_arr = [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'About the module',
			value: 'This module is made for simple control of GPIO pins on Raspberry Pi',
		},
		{
			type: 'static-text',
			id: 'config',
			width: 12,
			label: 'Configuration',
			value:
				'Please use checkboxes to specify which GPIO pins you want to use and configure them as input and outputs etc.. using dropdown menus',
		},
		{
			type: 'number',
			id: 'refresh_interval',
			required: true,
			width: 6,
			default: 5000,
			min: 1,
			max: 600000,
			label: 'GPIO Pins state refresh interval [ms]',
		},
		{
			type: 'number',
			id: 'base',
			required: true,
			width: 6,
			default: self.config?.base,
			label: 'GPIO Base Pin number Offset',
			min: 0,
			max: 10240,
		},
		...self.chain.configFields(),
	]

	const chainPinIds = [...new Set(Object.values(PORT_PINS).flat())]
	const chainUses = chainPinsExpression()
	/** @param {number} i */
	const pinVisible = (i) =>
		chainPinIds.includes(i) ? { isVisibleExpression: `$(options:use_gpio_${i}) && !(${chainUses})` } : {}

	for (let i = 0; i <= 27; i++) {
		const pinId = `use_gpio_${i}`
		configuration_fields_arr.push(
			{
				type: 'static-text',
				id: `space_${i}`,
				width: 12,
				label: `------------`,
				value: '',
			},
			{
				type: 'static-text',
				id: `GPIO_${i}_number`,
				width: 3,
				label: `GPIO pin ${i}`,
				value: `Configure GPIO pin number ${i}`,
			},
			// Pins the Chain serial port takes are locked while the Chain uses them
			...(chainPinIds.includes(i)
				? [
						{
							type: 'static-text',
							width: 3,
							label: `Use GPIO pin ${i}`,
							id: `gpio_chain_lock_${i}`,
							value: 'Taken by the Chain serial port',
							isVisibleExpression: chainUses,
						},
					]
				: []),
			{
				type: 'checkbox',
				width: 3,
				label: `Use GPIO pin ${i}`,
				id: pinId,
				default: false,
				...(chainPinIds.includes(i) ? { isVisibleExpression: `!(${chainUses})` } : {}),
			},
			{
				type: 'dropdown',
				width: 3,
				label: 'Set as IN/OUT',
				id: `gpio_in_out_${i}`,
				default: 'out',
				isVisibleData: { pinId: pinId },
				isVisible: (opt, data) => {
					return !!opt[data.pinId]
				},
				...pinVisible(i),
				choices: [
					{ id: 'out', label: 'OUTPUT' },
					{ id: 'in', label: 'INPUT' },
				],
			},
			{
				type: 'dropdown',
				width: 3,
				label: 'Trigger type',
				id: `gpio_trigger_type_${i}`,
				default: 'none',
				isVisibleData: { pinId: pinId },
				isVisible: (opt, data) => {
					return !!opt[data.pinId]
				},
				...pinVisible(i),
				choices: [
					{ id: 'none', label: 'NONE' },
					{ id: 'rising', label: 'RISING' },
					{ id: 'falling', label: 'FALLING' },
					{ id: 'both', label: 'RISING + FALLING' },
				],
			},
			{
				type: 'checkbox',
				width: 3,
				label: 'Enable debouncing',
				id: `gpio_enable_debounce_${i}`,
				default: false,
				isVisibleData: { pinId: pinId },
				isVisible: (opt, data) => {
					return !!opt[data.pinId]
				},
				...pinVisible(i),
			},
			{
				type: 'number',
				width: 3,
				label: 'Debounce time [ms]',
				id: `gpio_debounce_time_${i}`,
				default: 10,
				min: 0,
				max: 60000,
				isVisibleData: { pinId: pinId },
				isVisible: (opt, data) => {
					return !!opt[data.pinId]
				},
				...pinVisible(i),
			},
			{
				type: 'checkbox',
				width: 4,
				label: 'Invert values on this pin',
				id: `gpio_invert_values_${i}`,
				default: false,
				isVisibleData: { pinId: pinId },
				isVisible: (opt, data) => {
					return !!opt[data.pinId]
				},
				...pinVisible(i),
			},
		)
	}

	return configuration_fields_arr
}
