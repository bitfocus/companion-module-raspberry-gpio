import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PatchEngine } from '../lib/chain/patches.js'

const base = {
	n: 0,
	action: 'turn',
	direction: 1,
	invert: false,
	threshold: 30,
	repeatMs: 0,
	divider: 64,
	target: { kind: 'value', name: 'v' },
}

function engine(patches) {
	const out = []
	const e = new PatchEngine(patches, {
		turn: (t, s, p) => out.push(['turn', p.n, s]),
		press: (t, d, p) => out.push(['press', p.n, d]),
	})
	return { e, out }
}

test('encoder turns by its delta, invert flips it', () => {
	const { e, out } = engine([
		{ ...base, n: 0, input: 'turn', device: 'enc' },
		{ ...base, n: 1, input: 'turn', device: 'enc', invert: true },
	])
	e.onState('enc', { value: 3, delta: 3 }, { value: 3 })
	assert.deepEqual(out, [
		['turn', 0, 3],
		['turn', 1, -3],
	])
})

test('potentiometer gives one step per divider units', () => {
	const { e, out } = engine([{ ...base, input: 'turn', device: 'ang', divider: 100 }])
	e.onState('ang', { raw: 1000 }, {})
	e.onState('ang', { raw: 1150 }, {})
	e.onState('ang', { raw: 1260 }, {})
	e.onState('ang', { raw: 1000 }, {})
	assert.deepEqual(out, [
		['turn', 0, 1],
		['turn', 0, 1],
		['turn', 0, -2],
	])
})

test('two keys make a left/right pair', () => {
	const { e, out } = engine([{ ...base, input: 'pair', device: 'k1', device2: 'k2' }])
	e.onState('k1', { pressed: 1 }, {})
	e.onState('k1', { pressed: 0 }, {})
	e.onState('k2', { pressed: 1 }, {})
	assert.deepEqual(out, [
		['turn', 0, -1],
		['turn', 0, 1],
	])
})

test('a key can press the target', () => {
	const { e, out } = engine([{ ...base, input: 'button', device: 'k1', action: 'press' }])
	e.onState('k1', { pressed: 1 }, {})
	e.onState('k1', { pressed: 0 }, {})
	assert.deepEqual(out, [
		['press', 0, true],
		['press', 0, false],
	])
})

test('joystick axis steps once past the dead zone and repeats while held', async () => {
	const { e, out } = engine([{ ...base, input: 'x', device: 'joy', repeatMs: 50 }])
	e.onState('joy', { x: 10 }, { x: 10 })
	assert.equal(out.length, 0)
	e.onState('joy', { x: -80 }, { x: -80 })
	assert.deepEqual(out, [['turn', 0, -1]])
	await new Promise((r) => setTimeout(r, 650))
	e.onState('joy', { x: 0 }, { x: 0 })
	const n = out.length
	assert.ok(n >= 3, `expected repeats, got ${n}`)
	assert.ok(out.every((o) => o[2] === -1))
	await new Promise((r) => setTimeout(r, 200))
	assert.equal(out.length, n, 'stops once back in the dead zone')
	e.stop()
})
