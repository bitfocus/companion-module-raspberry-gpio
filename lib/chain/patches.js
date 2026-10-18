// @ts-check
// Patches turn Chain inputs into button presses and left/right turns somewhere in Companion.

/**
 * @typedef {{ kind: 'location', page: number, row: number, column: number }
 *   | { kind: 'surface', key: number }
 *   | { kind: 'value', name: string }} PatchTarget
 * @typedef {{
 *   n: number,
 *   input: 'turn'|'x'|'y'|'button'|'pair',
 *   device: string,
 *   device2?: string,
 *   action: 'turn'|'press',
 *   direction: 1 | -1,
 *   invert: boolean,
 *   threshold: number,
 *   repeatMs: number,
 *   divider: number,
 *   led?: boolean,
 *   target: PatchTarget,
 * }} Patch
 * @typedef {{ turn(target: PatchTarget, steps: number, patch: Patch): void, press(target: PatchTarget, down: boolean, patch: Patch): void }} PatchOutput
 */

const HOLD_DELAY_MS = 400

export class PatchEngine {
	#patches
	#out
	/** @type {Map<number, { timer?: NodeJS.Timeout, acc: number, last?: number, held: Set<string>, axisDir: number, axisMag: number }>} */
	#run = new Map()

	/** @param {Patch[]} patches @param {PatchOutput} out */
	constructor(patches, out) {
		this.#patches = patches
		this.#out = out
		for (const p of patches) this.#run.set(p.n, { acc: 0, held: new Set(), axisDir: 0, axisMag: 0 })
	}

	get patches() {
		return this.#patches
	}

	stop() {
		for (const r of this.#run.values()) if (r.timer) clearTimeout(r.timer)
		this.#run.clear()
	}

	/**
	 * @param {string} deviceKey
	 * @param {Record<string, number|string>} changes
	 * @param {Record<string, number|string>} state full state after the change
	 */
	onState(deviceKey, changes, state) {
		for (const p of this.#patches) {
			if (p.device !== deviceKey && p.device2 !== deviceKey) continue
			const r = this.#run.get(p.n)
			if (!r) continue
			const sign = p.invert ? -1 : 1
			switch (p.input) {
				case 'turn':
					if ('delta' in changes) {
						this.#out.turn(p.target, Number(changes.delta) * sign, p)
					} else if ('raw' in changes) {
						// potentiometer or slider: one step per `divider` raw units
						const raw = Number(changes.raw)
						if (r.last !== undefined) {
							r.acc += raw - r.last
							const div = Math.max(1, p.divider)
							const steps = Math.trunc(r.acc / div)
							if (steps) {
								r.acc -= steps * div
								this.#out.turn(p.target, steps * sign, p)
							}
						}
						r.last = raw
					}
					break
				case 'x':
				case 'y':
					if (p.input in changes) this.#axis(p, r, Number(state[p.input]) * sign)
					break
				case 'button':
				case 'pair':
					if ('pressed' in changes) {
						const dir = p.input === 'pair' ? (deviceKey === p.device ? -1 : 1) : p.direction
						this.#button(p, r, deviceKey, !!changes.pressed, dir * sign)
					}
					break
			}
		}
	}

	/**
	 * @param {Patch} p @param {any} r @param {string} who @param {boolean} down @param {number} dir
	 */
	#button(p, r, who, down, dir) {
		if (p.action === 'press') {
			if (down === r.held.has(who)) return
			if (down) r.held.add(who)
			else r.held.delete(who)
			this.#out.press(p.target, down, p)
			return
		}
		if (down) {
			r.held.add(who)
			this.#out.turn(p.target, dir, p)
			if (p.repeatMs > 0) {
				if (r.timer) clearTimeout(r.timer)
				const again = () => {
					if (!r.held.has(who)) return
					this.#out.turn(p.target, dir, p)
					r.timer = setTimeout(again, p.repeatMs)
				}
				r.timer = setTimeout(again, Math.max(HOLD_DELAY_MS, p.repeatMs))
			}
		} else {
			r.held.delete(who)
			if (r.timer) clearTimeout(r.timer)
			r.timer = undefined
		}
	}

	/**
	 * Joystick axis as a left/right pair: one step as it leaves the dead zone, then repeats
	 * that get faster the further it is pushed.
	 * @param {Patch} p @param {any} r @param {number} v -100..100
	 */
	#axis(p, r, v) {
		const thr = Math.max(1, Math.min(95, p.threshold))
		const dir = v > thr ? 1 : v < -thr ? -1 : 0
		r.axisMag = Math.abs(v)
		if (p.action === 'press') {
			if (dir === r.axisDir) return
			if (r.axisDir) this.#out.press(p.target, false, p)
			r.axisDir = dir
			if (dir) this.#out.press(p.target, true, p)
			return
		}
		if (dir === r.axisDir) return
		r.axisDir = dir
		if (r.timer) clearTimeout(r.timer)
		r.timer = undefined
		if (!dir) return
		this.#out.turn(p.target, dir, p)
		if (p.repeatMs <= 0) return
		const interval = () => {
			const t = Math.min(1, (r.axisMag - thr) / Math.max(1, 100 - thr))
			return Math.max(20, Math.round(p.repeatMs * (1 - 0.8 * t)))
		}
		const again = () => {
			if (r.axisDir !== dir) return
			this.#out.turn(p.target, dir, p)
			r.timer = setTimeout(again, interval())
		}
		r.timer = setTimeout(again, Math.max(HOLD_DELAY_MS, interval()))
	}
}
