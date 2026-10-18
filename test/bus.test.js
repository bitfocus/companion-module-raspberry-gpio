import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChainBus } from '../lib/chain/bus.js'
import { SimulatedChain } from '../lib/chain/simulator.js'
import { until } from './helpers.js'

test('discovers units, reads inputs, follows hot-plug and unplug', async () => {
	const sim = new SimulatedChain(['key', 'encoder', 'joystick', 'angle'])
	const bus = new ChainBus(sim, { pollInterval: 1, rescanInterval: 200 })
	const states = []
	const clicks = []
	bus.on('state', (d, c) => states.push([d.type.name, c]))
	bus.on('click', (d, k) => clicks.push([d.type.name, k]))
	bus.start()
	try {
		await until(() => bus.devices.length === 4)
		assert.deepEqual(
			bus.devices.map((d) => d.type.name),
			['key', 'encoder', 'joystick', 'angle'],
		)
		assert.ok(bus.devices.every((d) => d.uid.length === 8))

		sim.press(1, true)
		sim.turn(2, -3)
		sim.stick(3, 127, -127)
		sim.knob(4, 0)
		sim.click(1, 'long')
		await until(() => bus.devices[0].state.pressed === 1 && bus.devices[1].state.value === -3)
		await until(() => bus.devices[2].state.x === 100 && bus.devices[3].state.value === 0)
		assert.equal(bus.devices[2].state.y, -100)
		await until(() => clicks.length)
		assert.deepEqual(clicks[0], ['key', 'long'])
		assert.ok(states.some(([t, c]) => t === 'encoder' && c.delta === -3))

		// encoder counter wraps: +5 from 32765 is a delta of +5, not -65531
		sim.unit(2).value = 32765
		await until(() => bus.devices[1].state.value === 32765)
		sim.turn(2, 5)
		await until(() => bus.devices[1].state.value === -32766)
		assert.ok(states.some(([t, c]) => t === 'encoder' && c.delta === 5))

		const seen = []
		bus.on('devices', (d, added, removed) => seen.push([d.length, added.length, removed.length]))
		sim.plug('encoder')
		await until(() => bus.devices.length === 5)
		sim.unplugFrom(2)
		await until(() => bus.devices.length === 1, 3000)
		assert.deepEqual(seen[0], [5, 1, 0])
		assert.deepEqual(seen.at(-1)[0], 1)
	} finally {
		bus.stop()
	}
})

test('reports no-reply on an empty port', async () => {
	const sim = new SimulatedChain([])
	const bus = new ChainBus(sim)
	bus.start()
	try {
		await until(() => bus.status === 'no-reply')
	} finally {
		bus.stop()
	}
})

test('LED writes reach the unit', async () => {
	const sim = new SimulatedChain(['key'])
	const bus = new ChainBus(sim, { pollInterval: 1 })
	bus.start()
	try {
		await until(() => bus.devices.length === 1)
		await bus.setLed(bus.devices[0], 255, 128, 0)
		assert.deepEqual(sim.unit(1).led, [255, 128, 0])
	} finally {
		bus.stop()
	}
})
