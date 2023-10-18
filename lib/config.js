// @ts-check

/**
 * @returns {import("@companion-module/base").SomeCompanionConfigField[]}
 */
export function getConfigFields() {
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
			width: 3,
			default: 5000,
			min: 1,
			max: 600000,
			label: 'GPIO Pins state refresh interval [ms]',
		},
	]

	for (let i = 0; i <= 27; i++) {
		configuration_fields_arr.push(
			{
				type: 'static-text',
				id: `GPIO_${i}_number`,
				width: 12,
				label: `GPIO pin ${i}`,
				value: `Configure GPIO pin number ${i}`,
			},
			{
				type: 'checkbox',
				width: 12,
				label: `Use GPIO pin ${i}`,
				id: `use_gpio_${i}`,
				default: false,
			},
			{
				type: 'dropdown',
				width: 3,
				label: 'Set as IN/OUT',
				id: `gpio_in_out_${i}`,
				default: 'out',
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
			},
			{
				type: 'number',
				width: 3,
				label: 'Debounce time [ms]',
				id: `gpio_debounce_time_${i}`,
				default: 10,
				min: 0,
				max: 60000,
			},
			{
				type: 'checkbox',
				width: 12,
				label: 'Invert values on this pin',
				id: `gpio_invert_values_${i}`,
				default: false,
			}
		)
	}

	return configuration_fields_arr
}
