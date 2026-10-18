// @ts-check
import * as net from 'node:net'

/** Wait until fn() is truthy or time runs out. @param {() => any} fn */
export async function until(fn, ms = 2000, label = String(fn)) {
	const end = Date.now() + ms
	while (Date.now() < end) {
		const v = fn()
		if (v) return v
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error(`timed out waiting for ${label}`)
}

/** Stand-in for the Companion instance the ChainManager talks to. */
export function fakeInstance(config = {}) {
	return {
		label: 'chaintest',
		config,
		vars: /** @type {Record<string, any>} */ ({}),
		saved: /** @type {any[]} */ ([]),
		statuses: /** @type {any[]} */ ([]),
		logs: /** @type {string[]} */ ([]),
		log(/** @type {string} */ level, /** @type {string} */ msg) {
			this.logs.push(`${level}: ${msg}`)
		},
		setVariableValues(/** @type {any} */ v) {
			Object.assign(this.vars, v)
		},
		updateStatus(/** @type {any} */ s, /** @type {any} */ m) {
			this.statuses.push([s, m])
		},
		checkFeedbacks() {},
		saveConfig(/** @type {any} */ c) {
			this.saved.push(c)
		},
	}
}

/** A tiny Companion Satellite server: accepts devices and records what they send. */
export async function fakeSatelliteServer() {
	/** @type {string[]} */
	const lines = []
	/** @type {net.Socket[]} */
	const sockets = []
	const server = net.createServer((sock) => {
		sockets.push(sock)
		sock.write('BEGIN CompanionVersion=4.2.0 ApiVersion=1.10.0\n')
		let buf = ''
		sock.on('data', (d) => {
			buf += d.toString()
			let nl
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl)
				buf = buf.slice(nl + 1)
				lines.push(line)
				if (line.startsWith('ADD-DEVICE')) {
					const id = /DEVICEID=(\S+)/.exec(line)?.[1]
					sock.write(`ADD-DEVICE OK DEVICEID=${id}\n`)
				}
				if (line.startsWith('PING')) sock.write(`PONG${line.slice(4)}\n`)
			}
		})
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)))
	const port = /** @type {net.AddressInfo} */ (server.address()).port
	return {
		lines,
		port,
		/** @param {string} s */
		send: (s) => sockets.forEach((k) => k.write(s + '\n')),
		close: () => {
			sockets.forEach((k) => k.destroy())
			server.close()
		},
	}
}
