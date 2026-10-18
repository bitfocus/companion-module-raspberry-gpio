import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameParser, encodeFrame } from '../lib/chain/protocol.js'

test('ENUM frame matches the M5Chain layout', () => {
	assert.deepEqual([...encodeFrame(0xff, 0xfe, [0])], [0xaa, 0x55, 0x04, 0x00, 0xff, 0xfe, 0x00, 0xfd, 0x55, 0xaa])
})

test('parser finds frames split across chunks and skips garbage', () => {
	const p = new FrameParser()
	const a = encodeFrame(1, 0x10, [0x34, 0x12])
	const b = encodeFrame(2, 0xe0, [1, 0])
	const stream = Buffer.concat([Buffer.from([0x00, 0xaa, 0x13]), a, Buffer.from([0xaa, 0x55, 0xff]), b])
	const out = []
	for (let i = 0; i < stream.length; i += 3) out.push(...p.push(stream.subarray(i, i + 3)))
	assert.equal(out.length, 2)
	assert.deepEqual(out[0], { id: 1, cmd: 0x10, data: Buffer.from([0x34, 0x12]) })
	assert.equal(out[1].cmd, 0xe0)
})

test('parser rejects a bad checksum', () => {
	const f = encodeFrame(1, 0xe1, [1])
	f[f.length - 3] ^= 0xff
	assert.equal(new FrameParser().push(f).length, 0)
})
