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
