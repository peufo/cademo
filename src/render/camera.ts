import type { Box, Timeline, TimelineEvent } from '../timeline.ts'
import type { Camera, CameraTrack, Shot } from '../track.ts'

export type { Camera }

/**
 * La caméra automatique: elle découpe la vidéo en plans à partir des gestes de la timeline, et
 * rend une piste (`../track.ts`) que l'éditeur peut reprendre. Ses règles viennent de montages
 * faits à la main:
 *
 * 1. **Un plan par contexte, pas par geste.** Les gestes successifs partagent un cadrage tant qu'il
 *    reste assez serré pour chacun; la caméra ne bouge que quand c'est nécessaire.
 * 2. **Dosé.** Zoom des plans entre ×1,2 et `maxZoom` (×1,9); en dessous, la vue entière. Pas de
 *    gros plan, sauf demandé par le scénario (`click(…, { closeUp: true })`).
 * 3. **Une animation de l'interface ne se superpose jamais à un mouvement de caméra.** Un clic qui
 *    ouvre ou ferme un volet (`effect`, mesuré à l'enregistrement) est filmé dans un plan déjà
 *    assez large pour contenir le volet en largeur, et aucune transition ne démarre pendant
 *    l'animation qui suit.
 * 4. **La caméra bouge avec la main.** Un changement de plan démarre avec le mouvement de souris
 *    vers le geste suivant et dure à peu près autant: les deux mouvements se lisent comme un seul.
 * 5. **Poussée discrète** (0,005/s): l'image vit sans qu'on remarque le zoom.
 * 6. **Le contexte reste dans le cadre.** Le titre du volet, dialogue ou section où a lieu le
 *    geste (`context`, relevé à l'enregistrement) fait partie de ce que le plan montre: il dit où
 *    l'on est.
 */

export type CameraOptions = {
	/** Zoom maximal des plans. */
	maxZoom: number
	/** Zoom des gros plans demandés par le scénario. */
	closeUpZoom: number
}

const MIN_ZOOM = 1.2 // en dessous, autant rester en vue entière
const PAD = 80 // marge autour des gestes cadrés, en px du viewport
const EFFECT_PAD = 170 // marge, en largeur, autour d'un volet qui s'ouvre ou se ferme
const EFFECT_AREA = 0.06 // part de l'écran qu'un clic doit changer pour compter comme une animation
const ANIMATION = 0.8 // durée supposée d'une animation, quand l'enregistrement ne l'a pas mesurée
const KEEP_SHOT = 0.85 // un plan s'élargit pour un geste tant qu'il garde 85 % de son zoom…
const FIT_GESTURE = 0.75 // …et 75 % du zoom que ce geste aurait seul
const TRANSITION = { min: 0.7, max: 1.0, extra: 0.3 } // durée d'un changement de plan
const PUSH = 0.005
const OUTRO_AFTER = 0.8 // la vue entière finale suit le dernier geste
const CLOSE = { after: 0.15, in: 0.8, out: 0.9, push: 0.02 }

const union = (a: Box, b: Box): Box => {
	const x = Math.min(a.x, b.x)
	const y = Math.min(a.y, b.y)
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	}
}

type Click = Extract<TimelineEvent, { type: 'click' }>
type Note = Extract<TimelineEvent, { type: 'note' }>

/** Un geste tel que le spectateur le voit: la main part, agit, et l'interface réagit. */
type Beat = {
	/** Début du mouvement de souris (ou de la bulle qui l'annonce). */
	t: number
	end: number
	/** Durée du mouvement de souris qui l'ouvre. */
	move: number
	/** Ce que le geste touche: cible, champ, bulle. */
	box: Box
	/** Le volet que le clic ouvre ou ferme, s'il y en a un. */
	effect?: Box
	click?: Click
	/** Le geste commence par une bulle: la caméra doit être en place avant elle. */
	note?: number
}

export function beats(timeline: Timeline): Beat[] {
	const { width, height } = timeline.viewport
	const out: Beat[] = []
	let note: Note | undefined
	let current: Beat | undefined
	for (const e of timeline.events) {
		if (e.type === 'note') {
			note = e
		} else if (e.type === 'move') {
			current = {
				t: e.t,
				end: e.end,
				move: e.end - e.t,
				box: { x: e.x, y: e.y, width: 1, height: 1 },
			}
			if (note) {
				current.box = union(current.box, note.box)
				if (note.context) current.box = union(current.box, note.context)
				current.t = Math.min(current.t, note.t)
				current.note = note.t
				note = undefined
			}
			out.push(current)
		} else if (e.type === 'click' && current) {
			if (e.box) current.box = union(current.box, e.box)
			if (e.context) current.box = union(current.box, e.context)
			current.end = Math.max(current.end, e.t + 0.3)
			current.click = e
			if (e.effect && (e.effect.width * e.effect.height) / (width * height) >= EFFECT_AREA) {
				current.effect = e.effect
				current.end = Math.max(current.end, e.settled ?? e.t + ANIMATION)
			}
		} else if (e.type === 'type' && current) {
			if (e.box) current.box = union(current.box, e.box)
			if (e.context) current.box = union(current.box, e.context)
			current.end = Math.max(current.end, e.end)
		}
	}
	// Une bulle restée seule, sans geste après elle, fait un geste à elle seule.
	if (note)
		out.push({
			t: note.t,
			end: note.end,
			move: 0,
			box: note.context ? union(note.box, note.context) : note.box,
			note: note.t,
		})
	return out
}

export function autoTrack(timeline: Timeline, options: CameraOptions): CameraTrack {
	const { width: vw, height: vh } = timeline.viewport
	const overview: Camera = { x: vw / 2, y: vh / 2, zoom: 1 }

	/** Le cadrage qui montre `box`, et `effect` en largeur: un volet prend toute la hauteur. */
	const framing = (box: Box, effect?: Box): Camera => {
		let zoom = Math.min(vw / (box.width + 2 * PAD), vh / (box.height + 2 * PAD))
		let x0 = box.x
		let x1 = box.x + box.width
		if (effect) {
			// Toute la largeur, du geste au volet: le bouton cliqué et ce qu'il ouvre.
			x0 = Math.min(x0, effect.x)
			x1 = Math.max(x1, effect.x + effect.width)
			zoom = Math.min(zoom, vw / (x1 - x0 + 2 * EFFECT_PAD))
		}
		zoom = Math.min(options.maxZoom, zoom)
		if (zoom < MIN_ZOOM) return overview
		return { x: (x0 + x1) / 2, y: box.y + box.height / 2, zoom }
	}

	// --- plans: un par contexte ----------------------------------------------------------------
	type Group = { beats: Beat[]; box: Box; effect?: Box; cam: Camera }
	const groups: Group[] = []
	for (const beat of beats(timeline)) {
		const alone = framing(beat.box, beat.effect)
		const last = groups.at(-1)
		if (last) {
			const box = union(last.box, beat.box)
			const effect =
				last.effect && beat.effect ? union(last.effect, beat.effect) : (last.effect ?? beat.effect)
			const cam = framing(box, effect)
			// Le plan accueille le geste s'il ne doit pas trop reculer pour cela, et si le geste n'y
			// paraît pas trop petit.
			if (cam.zoom >= last.cam.zoom * KEEP_SHOT && cam.zoom >= alone.zoom * FIT_GESTURE) {
				Object.assign(last, { box, effect, cam })
				last.beats.push(beat)
				continue
			}
		}
		groups.push({ beats: [beat], box: beat.box, effect: beat.effect, cam: alone })
	}

	// Les animations de l'interface, pendant lesquelles la caméra ne bouge pas.
	const animations = groups
		.flatMap((g) => g.beats)
		.filter((b) => b.effect && b.click)
		.map((b) => ({ from: b.click!.t, to: b.click!.settled ?? b.click!.t + ANIMATION }))
	/**
	 * Décale une transition qui chevaucherait une animation: de préférence avant, pour que la
	 * caméra soit en place quand le volet bouge, sinon après. `earliest` borne le recul.
	 */
	const clearOfAnimations = (t: number, span: number, earliest = 0) => {
		for (const a of animations) {
			if (t >= a.to || t + span <= a.from) continue
			const before = a.from - span
			const clear = (x: number) => animations.every((b) => x >= b.to || x + span <= b.from)
			t = before >= earliest && clear(before) ? before : a.to
		}
		return t
	}

	// --- piste: chaque plan démarre avec le mouvement de la main --------------------------------
	const shots: Shot[] = []
	for (const group of groups) {
		const first = group.beats[0]
		const transition = Math.min(
			TRANSITION.max,
			Math.max(TRANSITION.min, first.move + TRANSITION.extra)
		)
		// Une bulle s'affiche dans un plan déjà posé; sinon la caméra part avec la main.
		const wanted = first.note !== undefined ? first.note - transition : first.t - 0.05
		const previous = shots.at(-1)
		const start = clearOfAnimations(Math.max(0, wanted), transition, (previous?.start ?? 0) + 0.3)
		if (previous) previous.end = start
		shots.push({ ...group.cam, start, end: timeline.duration, transition, push: PUSH })
	}

	// La fin en vue entière, pour montrer le résultat, si le dernier plan était serré.
	const last = shots.at(-1)
	const lastBeat = groups.at(-1)?.beats.at(-1)
	if (last && last.zoom > 1 && lastBeat) {
		const start = clearOfAnimations(lastBeat.end + OUTRO_AFTER, TRANSITION.max, last.start + 0.3)
		if (start < timeline.duration - 0.5) {
			last.end = start
			shots.push({ ...overview, start, end: timeline.duration, transition: TRANSITION.max, push: PUSH })
		}
	}

	// --- gros plans demandés par le scénario ---------------------------------------------------
	for (const beat of groups.flatMap((g) => g.beats)) {
		const c = beat.click
		if (!c?.closeUp || !c.box) continue
		const zoom = Math.max(
			2,
			Math.min(options.closeUpZoom, (vw * 0.3) / c.box.width, (vh * 0.22) / c.box.height)
		)
		const start = beat.t
		const end = c.t + CLOSE.after
		const host = shots.find((s) => s.start <= start && s.end > start)
		if (host) {
			const after: Shot = { ...host, start: end, transition: CLOSE.out }
			host.end = start
			if (after.end > after.start) shots.push(after)
		}
		shots.push({ x: c.x + 10, y: c.y + 18, zoom, start, end, transition: CLOSE.in, push: CLOSE.push })
	}

	// --- cadrages imposés par le scénario (`director.focus`) -------------------------------------
	const focus = timeline.events.filter((e) => e.type === 'focus')
	focus.forEach((e, i) => {
		if (e.box === 'auto') return
		const end = focus[i + 1]?.t ?? timeline.duration
		const cam = e.box ? framing(e.box) : overview
		for (const s of shots) {
			if (s.start < end && s.end > e.t) {
				if (s.start >= e.t) s.start = Math.min(s.end, end)
				else s.end = e.t
			}
		}
		shots.push({
			...cam,
			zoom: e.scale ?? cam.zoom,
			start: e.t,
			end,
			transition: TRANSITION.max,
			push: PUSH,
		})
	})

	return {
		duration: timeline.duration,
		shots: shots.filter((s) => s.end - s.start > 0.05).sort((a, b) => a.start - b.start),
		gapTransition: TRANSITION.max,
		gapPush: PUSH,
	}
}
