import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChainManager } from '../lib/chain/index.js'
import { ChainLeds, vivid } from '../lib/chain/leds.js'
import { ChainPatches } from '../lib/chain/patching.js'
import { ChainSurface } from '../lib/chain/surface.js'
import { fakeInstance, fakeSatelliteServer, until } from './helpers.js'

// Simulated units have stable UIDs: 51 <type> 00 <position>
const KEY1 = 'key-51030001'
const KEY2 = 'key-51030002'
const ENC = 'encoder-51010003'
const KEY4 = 'key-51030004'
const ANG = 'angle-51020005'

const extensions = [(x) => new ChainSurface(x), (x) => new ChainPatches(x), (x) => new ChainLeds(x)]

function setup(sat, extra = {}) {
	return {
		chain_enable: true,
		chain_port: 'sim',
		chain_sim_devices: 'key,key,encoder,key,angle',
		chain_poll_ms: 1,
		sat_enable: true,
		sat_host: '127.0.0.1',
		sat_port: sat.port,
		http_host: '127.0.0.1',
		http_port: 9,
		patch_count: 2,
		// encoder turns the fixed button 2/1/3
		p0_device: ENC,
		p0_input: 'turn',
		p0_target: 'location',
		p0_page: 2,
		p0_row: 1,
		p0_column: 3,
		// key 1 + key 2 turn surface key 6
		p1_device: KEY1,
		p1_device2: KEY2,
		p1_input: 'pair',
		p1_target: 'surface',
		p1_slot: 6,
		// key 4 and the angle stay off the surface
		[`dev_${KEY4.replace('-', '_')}_slot`]: 0,
		[`dev_${ANG.replace('-', '_')}_slot`]: 0,
		...extra,
	}
}

test('patched units show their button colour, the rest take colours from actions', async () => {
	const sat = await fakeSatelliteServer({ buttons: { '2/1/3': '#00ff00' } })
	const config = setup(sat)
	const self = fakeInstance(config)
	const m = new ChainManager(/** @type {any} */ (self), () => {}, extensions)
	await m.start(config)
	try {
		await until(() => m.bus?.devices.length === 5)
		const sim = m.sim
		const id = () => /DEVICEID=(\S+)/.exec(sat.lines.filter((l) => l.startsWith('ADD-DEVICE')).at(-1))[1]
		await until(() => self.vars.surface_connected === 1)

		// encoder -> fixed button 2/1/3, colour from the button subscription
		await until(() => sat.lines.some((l) => /^ADD-SUB SUBID=patch-0 LOCATION=2\/1\/3/.test(l)))
		await until(() => sim.unit(3).led.join() === '0,255,0')

		// key pair -> surface key 6: both keys take that key's colour
		sat.send(`KEY-STATE DEVICEID=${id()} KEY=5 TYPE=BUTTON COLOR=#0000ff PRESSED=0`)
		await until(() => sim.unit(1).led.join() === '0,0,255' && sim.unit(2).led.join() === '0,0,255')
		// the key's own surface colour does not override its patch
		sat.send(`KEY-STATE DEVICEID=${id()} KEY=0 TYPE=BUTTON COLOR=#ff0000 PRESSED=0`)
		await new Promise((r) => setTimeout(r, 100))
		assert.equal(sim.unit(1).led.join(), '0,0,255')

		// only the unpatched units are offered by the action
		const action = m.actions().chain_led_free
		assert.deepEqual(
			action.options[0].choices.map((c) => c.id),
			[KEY4, ANG],
		)
		await action.callback({ options: { device: ANG, color: 0xff8000 } })
		await until(() => sim.unit(5).led.join() === '255,128,0')

		// a patched unit is refused
		await action.callback({ options: { device: ENC, color: 0xffffff } })
		await new Promise((r) => setTimeout(r, 100))
		assert.equal(sim.unit(3).led.join(), '0,255,0')
		assert.ok(self.logs.some((l) => l.includes('follows a button')))

		// the action colour comes back after the unit is replugged
		sim.unplugFrom(5)
		await until(() => m.bus.devices.length === 4, 3000)
		sim.plug('angle')
		await until(() => m.bus.devices.length === 5)
		await until(() => sim.unit(5).led.join() === '255,128,0')
	} finally {
		await m.stop()
		sat.close()
	}
})

test('button colours work without registering the surface, and a missing setting is explained', async () => {
	const sat = await fakeSatelliteServer({ buttons: { '2/1/3': '#123456' } })
	const config = setup(sat, { sat_enable: false })
	const self = fakeInstance(config)
	const m = new ChainManager(/** @type {any} */ (self), () => {}, extensions)
	await m.start(config)
	try {
		await until(() => m.sim.unit(3).led.join() === vivid([0x12, 0x34, 0x56]).join())
		assert.ok(!sat.lines.some((l) => l.startsWith('ADD-DEVICE')))
	} finally {
		await m.stop()
		sat.close()
	}

	const sat2 = await fakeSatelliteServer()
	const config2 = setup(sat2)
	const self2 = fakeInstance(config2)
	const m2 = new ChainManager(/** @type {any} */ (self2), () => {}, extensions)
	await m2.start(config2)
	try {
		await until(() => self2.logs.some((l) => l.includes('Button Subscriptions API')))
	} finally {
		await m2.stop()
		sat2.close()
	}
})

test('vivid colours: full brightness, more saturation, gamma; greys go white or off', () => {
	assert.deepEqual(vivid([255, 0, 0]), [255, 0, 0])
	assert.deepEqual(vivid([0, 100, 0]), [0, 255, 0])
	assert.deepEqual(vivid([200, 200, 200]), [255, 255, 255])
	assert.deepEqual(vivid([30, 30, 30]), [0, 0, 0])
	// a muted blue gets its secondary channels pulled down further than plain gamma would
	const [r, g, b] = vivid([60, 120, 200])
	assert.equal(b, 255)
	assert.ok(r < 15 && g < 80, `${r},${g},${b}`)
})

test('exact style shows the button colour unchanged', async () => {
	const sat = await fakeSatelliteServer({ buttons: { '2/1/3': '#808040' } })
	const config = setup(sat, { chain_led_style: 'exact' })
	const self = fakeInstance(config)
	const m = new ChainManager(/** @type {any} */ (self), () => {}, extensions)
	await m.start(config)
	try {
		await until(() => m.sim?.unit(3).led.join() === '128,128,64')
	} finally {
		await m.stop()
		sat.close()
	}
})
