// @ts-check
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
