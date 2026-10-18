import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChainManager } from '../lib/chain/index.js'
import { getConfigFields } from '../lib/config.js'
import { fakeInstance, until } from './helpers.js'

const simConfig = {
	chain_enable: true,
	chain_port: 'sim',
	chain_sim_devices: 'key,key,encoder,joystick,angle',
	chain_poll_ms: 1,
}

test('discovered units are saved into the config and get variables and settings', async () => {
	const self = fakeInstance(simConfig)
	let defs = 0
	const m = new ChainManager(/** @type {any} */ (self), () => defs++)
	await m.start(simConfig)
	try {
		await until(() => self.saved.length && JSON.parse(self.saved.at(-1).chain_known).length === 5)
		const known = JSON.parse(self.saved.at(-1).chain_known)
		assert.deepEqual(
			known.map((k) => k.type),
			['key', 'key', 'encoder', 'joystick', 'angle'],
		)
		assert.ok(defs > 0)
		assert.deepEqual(
			m.views().map((v) => v.name),
			['key1', 'key2', 'encoder1', 'joystick1', 'angle1'],
		)
		assert.ok(m.configFields().some((f) => f.id === `dev_${known[2].key.replace('-', '_')}_name`))
		assert.ok(m.variables().some((v) => v.variableId === 'joystick1_x'))

		const sim = m.sim
		// first full poll done
		await until(() => m.bus.devices.every((d) => Object.keys(d.state).length))
		sim.press(1, true)
		sim.turn(3, 2)
		sim.stick(4, -127, 0)
		sim.knob(5, 4095)
		await until(() => self.vars.key1_pressed === 1 && self.vars.encoder1_value === 2)
		await until(() => self.vars.joystick1_x === -100 && self.vars.angle1_value === 100)

		// hot-plug: a new unit is saved and gets its own variables
		sim.plug('key')
		await until(() => JSON.parse(self.saved.at(-1).chain_known).length === 6)
		assert.ok(m.variables().some((v) => v.variableId === 'key3_pressed'))
	} finally {
		await m.stop()
	}
})

test('forget drops units that are not connected', () => {
	const m = new ChainManager(/** @type {any} */ (fakeInstance()), () => {})
	const out = m.cleanConfig({
		chain_forget: true,
		chain_known: JSON.stringify([{ key: 'key-1', type: 'key', uid: '1' }]),
	})
	assert.equal(out.chain_forget, false)
	assert.equal(out.chain_known, '[]')
})

test('GPIO 14 and 15 are locked while the Chain uses the Pi UART', () => {
	const self = fakeInstance()
	const m = new ChainManager(/** @type {any} */ (self), () => {})
	const out = m.cleanConfig({
		chain_enable: true,
		chain_port: '/dev/serial0',
		use_gpio_14: true,
		use_gpio_15: true,
		use_gpio_4: true,
	})
	assert.equal(out.use_gpio_14, false)
	assert.equal(out.use_gpio_15, false)
	assert.equal(out.use_gpio_4, true)
	// a USB adapter leaves them free
	assert.equal(m.cleanConfig({ chain_enable: true, chain_port: '/dev/ttyUSB0', use_gpio_14: true }).use_gpio_14, true)

	const fields = getConfigFields(/** @type {any} */ ({ config: {}, chain: m }))
	const use14 = fields.find((f) => f.id === 'use_gpio_14')
	const lock14 = fields.find((f) => f.id === 'gpio_chain_lock_14')
	assert.match(use14.isVisibleExpression, /^!\(\$\(options:chain_enable\) && /)
	assert.equal(lock14.type, 'static-text')
	assert.equal(fields.find((f) => f.id === 'use_gpio_4').isVisibleExpression, undefined)
})
