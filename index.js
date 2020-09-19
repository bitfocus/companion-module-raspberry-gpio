var instance_skel = require('../../instance_skel');

const gpio = require("onoff").Gpio;


class instance extends instance_skel {

	constructor(system,id,config) {
		super(system,id,config);
	}
	
	config_fields() {
		let configuration_fields_arr = [
			{
				type : "text",
				id : "info",
				width : "12",
				label : "About the module",
				value : "This module is made for simple control of GPIO pins on Raspberry Pi"

			},
			{
				type : "text",
				id : "config",
				width : "12",
				label : "Configuration",
				value : "Please use checkboxes to specify which GPIO pins you want to use and configure them as input and outputs etc.. using dropdown menus"
			},
			{
				type : "number",
				id : "refresh_interval",
				required : true,
				width : "3",
				default : 5000,
				min : 1,
				label : "GPIO Pins state refresh interval [ms]"
			}
		];

		let i;
		for (i = 0; i <= 27; i ++) {
			let gpio_pin_description_obj = {
				type : "text",
				id : "GPIO_" + String(i) + "_number",
				width : "12",
				label : "GPIO pin " + String(i),
				value : "Configure GPIO pin number " + String(i)
			};

			let gpio_pin_checkbox_obj = {
				type : "checkbox",
				width : "12",
				required : true,
				label : "Use GPIO pin " + String(i),
				id : "use_gpio_" + String(i),
				default : false
			};

			let gpio_in_out_dropdown_obj = {
				type : "dropdown",
				width : "3",
				required : true,
				label : "Set as IN/OUT",
				id : "gpio_in_out_" + String(i),
				default : "out",
				choices : [
					{id : "out", label : "OUTPUT"},
					{id : "in", label : "INPUT"},
				]
			};

			let gpio_trigger_type_obj = {
				type : "dropdown",
				width : "3",
				label : "Trigger type",
				id : "gpio_trigger_type_" + String(i),
				default : "none",
				choices : [
					{id : "none", label : "NONE"},
					{id : "rising", label : "RISING"},
					{id : "falling", label : "FALLING"},
					{id : "both", label : "RISING + FALLING"}
				]
			};

			let gpio_debounce_enable_obj = {
				type : "checkbox",
				width : "3",
				label : "Enable debouncing",
				id : "gpio_enable_debounce_" + String(i),
				default: false
			};

			let gpio_debounce_time_obj = {
				type : "number",
				width : "3",
				label : "Debounce time [ms]",
				id : "gpio_debounce_time_" + String(i),
				default : 10,
				min : 0,
			};

			let gpio_invert_values_obj = {
				type : "checkbox",
				width : "12",
				label : "Invert values on this pin",
				id : "gpio_invert_values_" + String(i),
				default : false
			};

			configuration_fields_arr.push(
				gpio_pin_description_obj,
				gpio_pin_checkbox_obj,
				gpio_in_out_dropdown_obj,
				gpio_trigger_type_obj,
				gpio_debounce_enable_obj,
				gpio_debounce_time_obj,
				gpio_invert_values_obj
				);
		}


		return configuration_fields_arr;
	}

	destroy() {
		this.log("info", "Destroying instance");

		this.stop_polling_for_states();

		for (var key in this.active_output_pin_objects) {
			this.active_output_pin_objects[key].unexport();
		}

		for (var key in this.active_input_pin_objects) {
			this.active_input_pin_objects[key].unexport();
		}

	}

	init() {
		this.log("info", "Initialising module");
		console.log("Initialising module");

		if (gpio.accessible) {
			this.log("debug", "GPIO is accessible");
			this.status(this.STATUS_OK, "Module OK");
		} else {
			this.log("error", "GPIO is inaccessible");
			this.status(this.STATUS_ERROR, "Module cannot be used");
			return;
		}

		this.processConfig();
		this.setupGPIO();
		this.poll_for_all_active_pin_states();
		this.start_polling_for_states()
		this.initActions();
		this.initFeedbacks();
		this.initVariables();
		this.initPresets();
		this.updateVariables();
	}

	initActions() {
		let actions = {};

		if (this.all_active_output_pins_to_display == undefined) {
			return;
		}

		let default_option = this.all_active_output_pins_to_display[0]["id"]

		actions["set_pin_low"] = {
			label : "Set pin LOW (eg. 0)",
			options : [
				{
					type : "dropdown",
					label : "Pin number",
					id : "pin_to_set_low",
					default : default_option,
					choices : this.active_output_pins_to_display
				}
			]
		}

		actions["set_pin_high"] = {
			label : "Set pin HIGH (eg. 1)",
			options : [
				{
					type : "dropdown",
					label : "Pin number",
					id : "pin_to_set_high",
					default : default_option,
					choices : this.active_output_pins_to_display
				}
			]
		}

		this.setActions(actions);
	}

	initPresets() {
		let preset_definitions = [];

		let i;
		for (i = 0; i < this.active_output_pins.length; i++) {
			let pin_num = this.active_output_pins[i]

			let set_pin_high_obj = {
				category : "Set GPIO Pin HIGH",
				label : "Set GPIO pin " + String(pin_num) + " HIGH",
				bank : {
					style : "text",
					text : "PIN " + String(pin_num) + " HIGH",
					size : "auto",
					color : this.rgb(255, 255, 255)
				},
				actions : [
					{
						action : "set_pin_high",
						options : {
							pin_to_set_high : String(pin_num)
						}
					}
				],
				feedbacks : [
					{
						type : "pin_state_feedback",
						options : {
							bg_high : this.rgb(0, 255, 0),
							bg_low : this.rgb(255, 0, 0),
							gpio_pin_number : String(pin_num)
						}
					}
				]
			}

			let set_pin_low_obj = {
				category : "Set GPIO Pin LOW",
				label : "Set GPIO pin " + String(pin_num) + " LOW",
				bank : {
					style : "text",
					text : "PIN " + String(pin_num) + " LOW",
					size : "auto",
					color : this.rgb(255, 255, 255)
				},
				actions : [
					{
						action : "set_pin_low",
						options : {
							pin_to_set_low : String(pin_num)
						}
					}
				],
				feedbacks : [
					{
						type : "pin_state_feedback",
						options : {
							bg_high : this.rgb(0, 255, 0),
							bg_low : this.rgb(255, 0, 0),
							gpio_pin_number : String(pin_num)
						}
					}
				]
			}

			preset_definitions.push(set_pin_high_obj);
			preset_definitions.push(set_pin_low_obj);

			let gpio_pushbutton_obj = {
				category : "GPIO Pin pushbutton",
				label : "GPIO pin " + String(pin_num) + " pushbutton",
				bank : {
					style : "text",
					text : "PIN " + String(pin_num) + " PUSH",
					size : "auto",
					color : this.rgb(255, 255, 255)
				},
				actions : [
					{
						action : "set_pin_high",
						options : {
							pin_to_set_high : String(pin_num)
						}
					}
				],
				release_actions : [
					{
						action : "set_pin_low",
						options : {
							pin_to_set_low : String(pin_num)
						}
					}
				],
				feedbacks : [
					{
						type : "pin_state_feedback",
						options : {
							bg_high : this.rgb(0, 255, 0),
							bg_low : this.rgb(255, 0, 0),
							gpio_pin_number : String(pin_num)
						}
					}
				]
			}

			let gpio_latch_button_obj = {
				category : "GPIO Pin LATCH button",
				label : "GPIO pin " + String(pin_num) + " LATCH button",
				bank : {
					style : "text",
					text : "PIN " + String(pin_num) + " LATCH",
					size : "auto",
					latch : true,
					color : this.rgb(255, 255, 255)
				},
				actions : [
					{
						action : "set_pin_high",
						options : {
							pin_to_set_high : String(pin_num)
						}
					}
				],
				release_actions : [
					{
						action : "set_pin_low",
						options : {
							pin_to_set_low : String(pin_num)
						}
					}
				],
				feedbacks : [
					{
						type : "pin_state_feedback",
						options : {
							bg_high : this.rgb(0, 255, 0),
							bg_low : this.rgb(255, 0, 0),
							gpio_pin_number : String(pin_num)
						}
					}
				]
			}

			preset_definitions.push(gpio_pushbutton_obj);
			preset_definitions.push(gpio_latch_button_obj);
		}

		this.setPresetDefinitions(preset_definitions);
	}

	initFeedbacks() {
		let feedbacks = {};

		if (this.all_active_pin_nums_to_display == undefined) {
			return;
		}

		let default_option = this.all_active_output_pins_to_display[0]["id"]

		feedbacks["pin_state_feedback"] = {
			label : "State of GPIO pin (HIGH/LOW)",
			description : "Feedback showing the state of specified GPIO pin",
			options : [
				{
					type : "colorpicker",
					label : "Background color (HIGH/1)",
					id : "bg_high",
					default : this.rgb(0, 255, 0)
				},
				{
					type : "colorpicker",
					label : "Background color (LOW/0)",
					id : "bg_low",
					default : this.rgb(255, 0, 0)
				},
				{
					type : "dropdown",
					label : "Pin number",
					id : "gpio_pin_number",
					default : default_option,
					choices : this.all_active_pin_nums_to_display
				}
			]
		}

		this.setFeedbackDefinitions(feedbacks);

	}

	feedback(feedback) {
		switch (feedback.type) {
			case "pin_state_feedback":
				let pin_state = this.all_active_pin_states[Number(feedback.options.gpio_pin_number)];
				if (pin_state == "HIGH") {
					return {bgcolor : feedback.options.bg_high};
				} else if (pin_state == "LOW") {
					return {bgcolor: feedback.options.bg_low}
				}

		}
	}

	initVariables() {
		let variable_definitions = [];

		let i;
		for (i = 0; i < this.all_active_pin_nums.length; i++) {
			let variable_obj = {
				label : "GPIO Pin " + String(this.all_active_pin_nums[i]) + " state",
				name : "gpio_state_" + String(this.all_active_pin_nums[i])
			};

			variable_definitions.push(variable_obj);
		}

		this.setVariableDefinitions(variable_definitions);
	}

	updateVariables() {
		for (var key in this.all_active_pin_states) {
			let pin_state = this.all_active_pin_states[key];
			this.setVariable("gpio_state_" + String(key), pin_state);
		}
	}

	updateConfig(config) {
		this.config = config;

		this.destroy();
		this.init();
	}

	processConfig() {
		let i;
		this.active_output_pins = [];
		this.all_active_output_pins_to_display = [];
		this.all_active_pin_nums = [];
		this.active_input_pins_with_trigger = [];
		this.active_input_pins = {};

		this.all_active_pin_states = {}

		for (i = 0; i <= 27; i++) {
			if (this.config["use_gpio_" + String(i)] == true) {
				let type = this.config["gpio_in_out_" + String(i)];
				let trigger_type = this.config["gpio_trigger_type_" + String(i)];
				let debounce_enable = this.config["gpio_enable_debounce_" + String(i)];
				let debounce_time = this.config["gpio_debounce_time_" + String(i)];
				let invert_values = this.config["gpio_invert_values_" + String(i)]

				this.all_active_pin_nums.push(i);
				this.all_active_pin_states[i] = "";

				if (type == "out") {
					this.active_output_pins.push(i)
					this.all_active_output_pins_to_display.push({"id" : i, "label" : String(i)})
				} else if (type == "in") {
					this.active_input_pins[i] = {
						"trigger_type" : trigger_type,
						"debounce_enable" : debounce_enable,
						"debounce_time" : debounce_time,
						"invert_values" : invert_values
					}
					if (trigger_type != "none") {
						this.active_input_pins_with_trigger.push(i);
					}
				}
			}
		}
	
		this.all_active_pin_nums_to_display = [];

		let j;
		for (j = 0; j < this.all_active_pin_nums.length; j++) {
			let pin_num = this.all_active_pin_nums[j];

			this.all_active_pin_nums_to_display.push({"id" : pin_num, "label" : String(pin_num)});
		}


		console.log(this.active_output_pins);
		console.log(this.active_input_pins);
		console.log(this.all_active_pin_nums_to_display);

	}

	setupGPIO() {
		this.active_output_pin_objects = {};
		this.active_input_pin_objects = {};

		let i;
		for (i = 0; i < this.active_output_pins.length; i++) {
			console.log("Pin_num: " + String(this.active_output_pins[i]) +  " : OUTPUT")
			let active_output_pin_obj = new gpio(this.active_output_pins[i], "out");
			this.active_output_pin_objects[this.active_output_pins[i]] = active_output_pin_obj;
		}

		for (var key in this.active_input_pins) {
			let debounce_enable = this.active_input_pins[key]["debounce_enable"];
			let trigger_type = this.active_input_pins[key]["trigger_type"];
			let debounce_time = this.active_input_pins[key]["debounce_time"];
			let invert_values = this.active_input_pins[key]["invert_values"];

			console.log("Pin_num: " + String(key));
			console.log("Trigger_type: " + String(trigger_type));
			console.log("Debounce_enable: " + String(debounce_enable));
			console.log("Debounce_time: " + String(debounce_time));
			console.log("Invert_values: " + String(invert_values));

			if (debounce_enable == true) {
				var active_input_pin_obj = new gpio(key, "in", trigger_type, {debounceTimeout : debounce_time, activeLow : invert_values});
			} else {
				var active_input_pin_obj = new gpio(key, "in", trigger_type, {activeLow : invert_values});   
			}

			this.active_input_pin_objects[key] = active_input_pin_obj;
		}

		this.all_pin_objects = Object.assign({}, this.active_output_pin_objects, this.active_input_pin_objects);

	}

	action(action) {
		console.log("Action: " + action.action)
		console.log("Option: " + String(action.options.pin_to_set_high))
		console.log("Option: " + String(action.options.pin_to_set_low))

		switch (action.action) {
			case "set_pin_low":
				let pin_to_set_low = action.options.pin_to_set_low;
				this.log("info", "Setting pin + " + pin_to_set_low + " to LOW (0)");
				this.set_gpio_pin_value(Number(pin_to_set_low), "LOW");
				
				let pin_to_low_state = this.poll_for_pin_state(pin_to_set_low);
				this.all_active_pin_states[pin_to_set_low] = pin_to_low_state;
				this.checkFeedbacks("pin_state_feedback");
				this.updateVariables();
				break;

			case "set_pin_high":
				let pin_to_set_high = action.options.pin_to_set_high;
				this.log("info", "Setting pin + " + pin_to_set_high + " to HIGH (1)");
				this.set_gpio_pin_value(Number(pin_to_set_high), "HIGH");

				let pin_to_high_state = this.poll_for_pin_state(pin_to_set_high);
				this.all_active_pin_states[pin_to_set_high] = pin_to_high_state;
				this.checkFeedbacks("pin_state_feedback");
				this.updateVariables();
				break;
		}
	}

	set_gpio_pin_value(pin_number, value) {
		let pin_obj = this.active_output_pin_objects[pin_number];

		switch (value) {
			case "HIGH":
				pin_obj.writeSync(1);
				break;
			
			case "LOW":
				pin_obj.writeSync(0);
				break;
		}
	}

	poll_for_pin_state(pin_number) {
		let gpio_obj = this.all_pin_objects[pin_number];

		let state = gpio_obj.readSync()

		switch (state) {
			case 0:
				return "LOW";
			case 1:
				return "HIGH"
		}
	}
	poll_for_all_active_pin_states() {
		let i;
		
		let pins_to_get_states = Object.keys(this.all_active_pin_states);
		for (i=0; i < pins_to_get_states.length; i++) {
			let pin_state = this.poll_for_pin_state(pins_to_get_states[i]);
			this.all_active_pin_states[pins_to_get_states[i]] = pin_state;
		}

		this.checkFeedbacks("pin_state_feedback");
		this.updateVariables();
	}

	start_polling_for_states() {
		this.states_poller = setInterval(this.poll_for_all_active_pin_states.bind(this), this.config.refresh_interval);

		let i;
		console.log(this.active_input_pins_with_trigger);
		for (i = 0; i < this.active_input_pins_with_trigger.length; i++) {
			let pin_obj = this.active_input_pin_objects[this.active_input_pins_with_trigger[i]];
			pin_obj.watch( (err, value) => {
				if (err) {
					this.log("error", "Problem on interrupt handler")
					throw err;
				}

				this.log("info","Registering interrupt, refreshing all GPIO Pin states");

				this.poll_for_all_active_pin_states();
				this.checkFeedbacks("pin_state_feedback");
			})
		}
	}

	stop_polling_for_states() {
		clearInterval(this.states_poller);
	}
}

exports = module.exports = instance;