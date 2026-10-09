import type { CursorKind, Timeline } from './timeline.ts'

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

export type CursorState = {
	x: number
	y: number
	kind: CursorKind
	/** 1 au repos, moins pendant l'appui d'un clic. */
	press: number
	/** Clics récents: âge en secondes et position, pour les ondes. */
	ripples: { age: number; x: number; y: number }[]
}

/**
 * La position du curseur à l'instant `t`, en px du viewport. Les déplacements suivent une légère
 * courbe plutôt qu'une ligne droite, comme une main.
 */
export function cursorAt(timeline: Timeline, t: number): CursorState {
	let pos = { ...timeline.cursorStart }
	let kind: CursorKind = 'arrow'
	let press = 1
	const ripples: CursorState['ripples'] = []

	for (const e of timeline.events) {
		if (e.t > t) break
		if (e.type === 'move') {
			if (t >= e.end) {
				pos = { x: e.x, y: e.y }
				kind = e.cursor
				continue
			}
			const span = Math.max(0.001, e.end - e.t)
			const p = easeInOut((t - e.t) / span)
			const dx = e.x - pos.x
			const dy = e.y - pos.y
			const bend = Math.sin(Math.PI * p) * 0.12
			pos = { x: pos.x + dx * p - dy * bend, y: pos.y + dy * p + dx * bend }
			if (p > 0.8) kind = e.cursor
		} else if (e.type === 'click') {
			const age = t - e.t
			if (age < 0.6) ripples.push({ age, x: e.x, y: e.y })
			if (age < 0.28) press = 1 - 0.22 * Math.sin((Math.PI * age) / 0.28)
		}
	}
	return { ...pos, kind, press, ripples }
}

