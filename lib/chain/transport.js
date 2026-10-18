// @ts-check
// Raw serial port on Linux without native add-ons: stty sets the line up, then the tty is
// read and written as a non-blocking file descriptor.
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as tty from 'node:tty'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class SerialTransport extends EventEmitter {
	/** @type {number | null} */
	#fd = null
	/** @type {tty.ReadStream | null} */
	#reader = null

	/** @param {string} path @param {number} [baud] */
	constructor(path, baud = 115200) {
		super()
		this.name = path
		this.baud = baud
	}

	async open() {
		await execFileAsync('stty', [
			'-F',
			this.name,
			String(this.baud),
			'raw',
			'-echo',
			'-echoe',
			'-echok',
			'-echoctl',
			'-echoke',
			'-ixon',
			'-ixoff',
			'-crtscts',
			'cs8',
			'-cstopb',
			'-parenb',
			'clocal',
			'cread',
			'-hupcl',
		])
		const fd = fs.openSync(this.name, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK)
		this.#fd = fd
		if (tty.isatty(fd)) {
			const reader = new tty.ReadStream(fd)
			reader.on('data', (/** @type {Buffer} */ d) => this.emit('data', d))
			reader.on('error', (e) => this.emit('error', e))
			this.#reader = reader
		} else {
			// a FIFO or a socat pty pair in tests
			const reader = /** @type {any} */ (fs.createReadStream('', { fd, autoClose: false }))
			reader.on('data', (/** @type {Buffer} */ d) => this.emit('data', d))
			reader.on('error', (/** @type {Error} */ e) => this.emit('error', e))
			this.#reader = reader
		}
	}

	/** @param {Buffer} buf */
	write(buf) {
		if (this.#fd === null) throw new Error(`${this.name} is not open`)
		let off = 0
		while (off < buf.length) {
			try {
				off += fs.writeSync(this.#fd, buf, off)
			} catch (e) {
				if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EAGAIN') throw e
			}
		}
	}

	close() {
		this.#reader?.destroy()
		this.#reader = null
		if (this.#fd !== null) {
			try {
				fs.closeSync(this.#fd)
			} catch {
				// tty.ReadStream may already have closed it
			}
		}
		this.#fd = null
		this.emit('close')
	}
}
