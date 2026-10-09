/**
 * La piste de la caméra: une suite de plans, chacun un cadrage tenu de `start` à `end`. Entre deux
 * plans, ou dans un trou de la piste (vue entière), la caméra passe d'un cadrage à l'autre en
 * `transition` secondes, en partant toujours de là où elle se trouve vraiment: aucun saut, sauf
 * `transition: 0`, qui est une coupe voulue.
 *
 * La caméra automatique produit une piste; l'éditeur la modifie et l'écrit dans `camera.json`; le
 * rendu lit l'une ou l'autre. Les trois partagent ce module, donc ce qu'on voit dans l'éditeur est
 * ce qui sera rendu.
 */

/** Où regarde la caméra: un point du viewport (px CSS) et un facteur de zoom (1 = vue entière). */
export type Camera = { x: number; y: number; zoom: number }

export type Shot = Camera & {
	start: number
	end: number
	/** Durée du mouvement qui amène à ce plan, en secondes. */
	transition: number
	/** Poussée lente pendant le plan, en zoom relatif par seconde (0 = immobile). */
	push?: number
}

export type CameraTrack = {
	/** Durée de la vidéo brute pour laquelle la piste a été faite: une autre prise l'invalide. */
	duration: number
	shots: Shot[]
	/** Transition vers la vue entière quand la piste a un trou. */
	gapTransition?: number
	/** Poussée de la vue entière. */
	gapPush?: number
}

export const DEFAULT_PUSH = 0.005

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

/** Entre deux cadrages: position linéaire, zoom en échelle logarithmique. */
export const mix = (a: Camera, b: Camera, k: number): Camera => ({
	x: a.x + (b.x - a.x) * k,
	y: a.y + (b.y - a.y) * k,
	zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * k),
})

/** Les plans triés, les trous remplis par la vue entière, de 0 à `duration`. */
export function fillGaps(
	track: CameraTrack,
	viewport: { width: number; height: number }
): Shot[] {
	const overview = (start: number, end: number): Shot => ({
		x: viewport.width / 2,
		y: viewport.height / 2,
		zoom: 1,
		start,
		end,
		transition: track.gapTransition ?? 1,
		push: track.gapPush ?? DEFAULT_PUSH,
	})
	const shots = [...track.shots]
		.filter((s) => s.end > s.start)
		.sort((a, b) => a.start - b.start)
	const out: Shot[] = []
	let cursor = 0
	for (const shot of shots) {
		const start = Math.max(shot.start, cursor)
		if (start - cursor > 0.01) out.push(overview(cursor, start))
		if (shot.end > start) out.push({ ...shot, start })
		cursor = Math.max(cursor, shot.end)
	}
	if (track.duration - cursor > 0.01 || !out.length) out.push(overview(cursor, track.duration))
	return out
}

/** La position de la caméra à chaque instant. */
export function evaluateTrack(track: CameraTrack, viewport: { width: number; height: number }) {
	const shots = fillGaps(track, viewport)

	/** Le plan poussé selon son âge: vite au début, puis de plus en plus lentement. */
	const pushed = (shot: Shot, t: number): Camera => {
		const age = Math.max(0, t - shot.start)
		const push = shot.push ?? DEFAULT_PUSH
		return { x: shot.x, y: shot.y, zoom: shot.zoom * (1 + push * 4 * (1 - Math.exp(-age / 4))) }
	}

	// Chaque transition part de la position réelle de la caméra au début de son plan, même si la
	// précédente n'était pas finie.
	const startCams: Camera[] = []
	const within = (i: number, t: number): Camera => {
		const current = pushed(shots[i], t)
		if (i === 0) return current
		const span = shots[i].transition
		if (span <= 0) return current
		return mix(startCams[i], current, easeInOut(Math.min(1, (t - shots[i].start) / span)))
	}
	shots.forEach((shot, i) => {
		startCams[i] = i === 0 ? pushed(shot, shot.start) : within(i - 1, shot.start)
	})

	return {
		shots,
		at: (t: number): Camera => within(Math.max(0, shots.findLastIndex((s) => t >= s.start)), t),
	}
}
