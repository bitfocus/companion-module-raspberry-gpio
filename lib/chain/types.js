// @ts-check
// Chain device types: what to poll, how to decode it, and which values each one exposes.

/**
 * @typedef {Record<string, number|string>} DeviceState
 * @typedef {{ cmd: number, data?: number[], decode: (data: Buffer, state: DeviceState) => void }} PollRequest
 * @typedef {{
 *   code: number,
 *   name: string,
 *   label: string,
 *   button?: boolean,
 *   led?: boolean,
 *   polls: PollRequest[],
 *   values: { id: string, name: string }[],
 *   axes?: string[],
 *   turn?: string,
 * }} ChainType
 */

/** @param {Buffer} d @param {number} [o] */
const u16 = (d, o = 0) => (d.length >= o + 2 ? d.readUInt16LE(o) : 0)
/** @param {Buffer} d @param {number} [o] */
const i16 = (d, o = 0) => (d.length >= o + 2 ? d.readInt16LE(o) : 0)
/** @param {Buffer} d @param {number} [o] */
const i8 = (d, o = 0) => (d.length >= o + 1 ? d.readInt8(o) : 0)

/** @type {PollRequest} */
const buttonPoll = { cmd: 0xe1, decode: (d, s) => (s.pressed = d[0] ? 1 : 0) }

const pressedValues = [
	{ id: 'pressed', name: 'pressed (0/1)' },
	{ id: 'click', name: 'last click (single, double, long)' },
]

/** @type {ChainType[]} */
export const CHAIN_TYPES = [
	{
		code: 0x01,
		name: 'encoder',
		label: 'Encoder',
		button: true,
		led: true,
		turn: 'value',
		polls: [{ cmd: 0x10, decode: (d, s) => (s.value = i16(d)) }, buttonPoll],
		values: [{ id: 'value', name: 'count' }, { id: 'delta', name: 'last turn (steps)' }, ...pressedValues],
	},
	{
		code: 0x02,
		name: 'angle',
		label: 'Angle (potentiometer)',
		led: true,
		turn: 'raw',
		polls: [
			{
				cmd: 0x30,
				decode: (d, s) => {
					s.raw = u16(d) & 0x0fff
					s.value = Math.round((Number(s.raw) / 4095) * 1000) / 10
				},
			},
		],
		values: [
			{ id: 'value', name: 'position (0-100 %)' },
			{ id: 'raw', name: 'raw (0-4095)' },
		],
	},
	{
		code: 0x03,
		name: 'key',
		label: 'Key',
		button: true,
		led: true,
		polls: [buttonPoll],
		values: pressedValues,
	},
	{
		code: 0x04,
		name: 'joystick',
		label: 'Joystick',
		button: true,
		led: true,
		axes: ['x', 'y'],
		polls: [
			{
				// mapped int8, -127..127 per axis
				cmd: 0x35,
				decode: (d, s) => {
					s.x = Math.round((i8(d, 0) / 127) * 100)
					s.y = Math.round((i8(d, 1) / 127) * 100)
				},
			},
			buttonPoll,
		],
		values: [{ id: 'x', name: 'X (-100..100)' }, { id: 'y', name: 'Y (-100..100)' }, ...pressedValues],
	},
	{
		code: 0x05,
		name: 'tof',
		label: 'ToF distance',
		led: true,
		polls: [{ cmd: 0x50, decode: (d, s) => (s.distance = u16(d)) }],
		values: [{ id: 'distance', name: 'distance (mm)' }],
	},
	{ code: 0x06, name: 'chainbus', label: 'Unit ChainBus', polls: [], values: [] },
	{
		code: 0x07,
		name: 'switch',
		label: 'Switch (slider)',
		led: true,
		turn: 'raw',
		polls: [
			{
				cmd: 0x30,
				decode: (d, s) => {
					s.raw = u16(d) & 0x0fff
					s.value = Math.round((Number(s.raw) / 4095) * 1000) / 10
				},
			},
			{ cmd: 0x36, decode: (d, s) => (s.on = d[0] ? 1 : 0) },
		],
		values: [
			{ id: 'value', name: 'position (0-100 %)' },
			{ id: 'raw', name: 'raw (0-4095)' },
			{ id: 'on', name: 'on (0/1)' },
		],
	},
	{
		code: 0x08,
		name: 'pedal',
		label: 'Pedal',
		button: true,
		led: true,
		polls: [buttonPoll, { cmd: 0xe2, decode: (d, s) => (s.on = d[0] ? 1 : 0) }],
		values: [...pressedValues, { id: 'on', name: 'switch on (0/1)' }],
	},
	{
		code: 0x09,
		name: 'pir',
		label: 'PIR',
		polls: [{ cmd: 0x37, decode: (d, s) => (s.person = d[0] ? 1 : 0) }],
		values: [{ id: 'person', name: 'person present (0/1)' }],
	},
	{ code: 0x0a, name: 'mic', label: 'MIC', led: true, polls: [], values: [] },
	{ code: 0x0b, name: 'buzzer', label: 'Buzzer', led: true, polls: [], values: [] },
	{ code: 0x0c, name: 'servos', label: '8Servos', polls: [], values: [] },
	{ code: 0x0d, name: 'mono', label: 'Mono display', polls: [], values: [] },
	{ code: 0x0e, name: 'rgb', label: 'RGB', led: true, polls: [], values: [] },
	{ code: 0x0f, name: 'env', label: 'ENV', led: true, polls: [], values: [] },
	{ code: 0x10, name: 'imu', label: 'IMU', led: true, polls: [], values: [] },
	{ code: 0x11, name: 'dlight', label: 'DLight', led: true, polls: [], values: [] },
]

const byCode = new Map(CHAIN_TYPES.map((t) => [t.code, t]))
const byName = new Map(CHAIN_TYPES.map((t) => [t.name, t]))

/** @param {number} code @returns {ChainType} */
export function typeFromCode(code) {
	return (
		byCode.get(code) ?? {
			code,
			name: `type${code}`,
			label: `Unknown type 0x${code.toString(16)}`,
			polls: [],
			values: [],
		}
	)
}

/** @param {string} name */
export function typeFromName(name) {
	return byName.get(name)
}

/** Click event codes carried by an unsolicited 0xE0 frame */
export const EVENT = {
	0x0000: { click: 'single' },
	0x0001: { click: 'double' },
	0x0002: { click: 'long' },
	0x0400: { on: 0 },
	0x0401: { on: 1 },
	0x0500: { person: 0 },
	0x0501: { person: 1 },
}
