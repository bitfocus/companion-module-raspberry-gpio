// @ts-check
// Press or turn a fixed button through Companion's HTTP API (/api/location/<page>/<row>/<column>/...).

/**
 * @param {{ host: string, port: number }} conn
 * @param {{ page: number, row: number, column: number }} loc
 * @param {'press'|'down'|'up'|'rotate-left'|'rotate-right'} what
 */
export async function locationCall(conn, loc, what) {
	const url = `http://${conn.host}:${conn.port}/api/location/${loc.page}/${loc.row}/${loc.column}/${what}`
	const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(2000) })
	if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text().catch(() => '')}`.trim())
}
