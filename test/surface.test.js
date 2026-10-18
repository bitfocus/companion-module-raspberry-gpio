import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChainManager } from '../lib/chain/index.js'
import { ChainLeds, vivid } from '../lib/chain/leds.js'
import { ChainSurface } from '../lib/chain/surface.js'
import { fakeInstance, fakeSatelliteServer, until } from './helpers.js'

test('the Chain shows up as a Companion surface and its LEDs follow key colours', async () => {
	const sat = await fakeSatelliteServer()
	const config = {
		chain_enable: true,
		chain_port: 'sim',
		chain_sim_devices: 'key,key,encoder,joystick,angle',
		chain_poll_ms: 1,
		sat_enable: true,
		sat_host: '127.0.0.1',
		sat_port: sat.port,
		sat_cols: 5,
	}
	const self = fakeInstance(config)
	const m = new ChainManager(/** @type {any} */ (self), () => {}, [(x) => new ChainSurface(x), (x) => new ChainLeds(x)])
	await m.start(config)
	const adds = () => sat.lines.filter((l) => l.startsWith('ADD-DEVICE'))
	try {
		await until(() => adds().at(-1)?.includes('KEYS_TOTAL=5'))
		const add = adds().at(-1)
		assert.match(add, /PRODUCT_NAME="M5Stack Chain"/)
		await until(() => self.vars.surface_connected === 1)
		const id = /DEVICEID=(\S+)/.exec(add)[1]

		const sim = m.sim
		// first full poll done
		await until(() => m.bus.devices.every((d) => Object.keys(d.state).length))
		sim.press(1, true)
		sim.turn(3, 2)
		await until(() => sat.lines.some((l) => /KEY-PRESS .*KEY=0 PRESSED=true/.test(l)))
		await until(() => sat.lines.filter((l) => /KEY-ROTATE .*KEY=2 DIRECTION=1/.test(l)).length === 2)
		// the first poll is not reported as a release
		assert.ok(!sat.lines.some((l) => /KEY-PRESS .*KEY=1 PRESSED=false/.test(l)))
		sim.press(1, false)
		await until(() => sat.lines.some((l) => /KEY-PRESS .*KEY=0 PRESSED=false/.test(l)))

		sat.send(`KEY-STATE DEVICEID=${id} KEY=2 TYPE=BUTTON COLOR=#ff8000 TEXTCOLOR=#ffffff PRESSED=0`)
		await until(() => sim.unit(3).led.join() === vivid([255, 128, 0]).join())

		// a new unit grows the surface
		sim.plug('encoder')
		await until(() => adds().at(-1)?.includes('KEYS_TOTAL=6'))
	} finally {
		await m.stop()
		sat.close()
	}
})
