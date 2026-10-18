import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChainManager } from '../lib/chain/index.js'
import { ChainPatches } from '../lib/chain/patching.js'
import { ChainSurface } from '../lib/chain/surface.js'
import { fakeHttpApi, fakeInstance, fakeSatelliteServer, until } from './helpers.js'

// Simulated units have stable UIDs: 51 <type> 00 <position>
const KEY1 = 'key-51030001'
const KEY2 = 'key-51030002'
const ENC = 'encoder-51010003'
const JOY = 'joystick-51040004'

test('patches turn and press buttons, surface keys and turn values', async () => {
	const api = await fakeHttpApi()
	const sat = await fakeSatelliteServer()
	const config = {
		chain_enable: true,
		chain_port: 'sim',
		chain_sim_devices: 'key,key,encoder,joystick',
		chain_poll_ms: 1,
		sat_enable: true,
		sat_host: '127.0.0.1',
		sat_port: sat.port,
		http_host: '127.0.0.1',
		http_port: api.port,
		patch_count: 4,
		// encoder turns the button at page 2, row 1, column 3
		p0_device: ENC,
		p0_input: 'turn',
		p0_target: 'location',
		p0_page: 2,
		p0_row: 1,
		p0_column: 3,
		// joystick Y steps a turn value
		p1_device: JOY,
		p1_input: 'y',
		p1_target: 'value',
		p1_vname: 'zoom',
		p1_vmin: 0,
		p1_vmax: 10,
		p1_vstep: 2,
		p1_repeat: 0,
		// key 1 + key 2 turn surface key 5 left and right
		p2_device: KEY1,
		p2_device2: KEY2,
		p2_input: 'pair',
		p2_target: 'surface',
		p2_slot: 5,
		// joystick button presses page 1 row 0 column 0
		p3_device: JOY,
		p3_input: 'button',
		p3_action: 'press',
		p3_target: 'location',
		p3_page: 1,
		p3_row: 0,
		p3_column: 0,
	}
	const self = fakeInstance(config)
	const m = new ChainManager(/** @type {any} */ (self), () => {}, [
		(x) => new ChainSurface(x),
		(x) => new ChainPatches(x),
	])
	await m.start(config)
	try {
		await until(() => m.bus?.devices.length === 4)
		assert.deepEqual(
			m.bus.devices.map((d) => d.key),
			[KEY1, KEY2, ENC, JOY],
		)
		await until(() => self.vars.surface_connected === 1)
		const sim = m.sim
		await until(() => m.bus.devices.every((d) => Object.keys(d.state).length))

		sim.turn(3, 2)
		await until(() => api.calls.filter((c) => c === 'POST /api/location/2/1/3/rotate-right').length === 2)
		sim.turn(3, -1)
		await until(() => api.calls.includes('POST /api/location/2/1/3/rotate-left'))

		sim.press(1, true)
		await until(() => sat.lines.some((l) => /KEY-ROTATE .*KEY=4 DIRECTION=-1/.test(l)))
		sim.press(1, false)
		sim.press(2, true)
		await until(() => sat.lines.some((l) => /KEY-ROTATE .*KEY=4 DIRECTION=1/.test(l)))

		for (let i = 0; i < 7; i++) {
			sim.stick(4, 0, 127)
			await until(() => m.bus.devices[3].state.y === 100)
			sim.stick(4, 0, 0)
			await until(() => m.bus.devices[3].state.y === 0)
		}
		assert.equal(self.vars.value_zoom, 10, 'clamped at max')

		sim.press(4, true)
		await until(() => api.calls.includes('POST /api/location/1/0/0/down'))
		sim.press(4, false)
		await until(() => api.calls.includes('POST /api/location/1/0/0/up'))
	} finally {
		await m.stop()
		api.close()
		sat.close()
	}
})
