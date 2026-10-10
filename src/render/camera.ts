import type { Box, Edges, Timeline, TimelineEvent } from '../timeline.ts'
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
 *    l'animation qui suit. Un clic qui change de page anime tout l'écran: il est filmé en vue
 *    entière.
 * 4. **La caméra bouge avec la main.** Un changement de plan démarre avec le mouvement de souris
 *    vers le geste suivant et dure à peu près autant: les deux mouvements se lisent comme un seul.
 * 5. **Poussée discrète** (0,005/s): l'image vit sans qu'on remarque le zoom. La vue entière, elle,
 *    reste immobile: la pousser rognerait les marges de la page (règle 7).
 * 6. **Le contexte reste dans le cadre.** Le titre du volet, dialogue ou section où a lieu le
 *    geste (`context`, relevé à l'enregistrement) fait partie de ce que le plan montre: il dit où
 *    l'on est.
 * 7. **Les marges restent dans le cadre.** L'espace entre un élément et le bord est ce qui rend
 *    une interface lisible; un bord de cadre qui tranche une carte au ras de son contour le fait
 *    disparaître. Le conteneur du geste (`container`) se montre donc entier, avec sa marge, dès
 *    qu'il tient dans un plan d'au moins ×1,2: une carte sur toute la largeur vaut mieux qu'une
 *    carte tranchée. Sans conteneur entier, un plan à peine zoomé (moins de ×1,35) ne
 *    rapprocherait rien: il ne ferait que rogner les marges de la page, autant la vue entière.
 *    Et un bord de cadre ne tranche pas une barre de la page (en-tête, barre latérale, relevées à
 *    l'enregistrement): le cadre glisse pour la laisser dehors, ou à défaut la prend entière.
 * 8. **Les actions restent visibles.** Une barre d'actions flottante (enregistrer, annuler) dit ce
 *    que le geste prépare: elle reste dans le cadre, quitte à ne plus zoomer qu'à ×1,05.
 */

export type CameraOptions = {
	/** Zoom maximal des plans. */
	maxZoom: number
	/** Zoom des gros plans demandés par le scénario. */
	closeUpZoom: number
}

const MIN_ZOOM = 1.35 // en dessous, le plan rogne les marges de la page sans rien rapprocher
const PAD = 80 // marge autour des gestes cadrés, en px du viewport
const CONTAINER_PAD = 32 // marge gardée autour d'un conteneur montré entier
const CONTAINER_ZOOM = 1.2 // un conteneur entre entier tant que le plan garde ce zoom
const TOOLBAR_PAD = 16 // marge gardée autour d'une barre d'actions flottante
const TOOLBAR_ZOOM = 1.05 // une barre d'actions entre dans le cadre tant que le plan garde ce zoom
const EFFECT_PAD = 170 // marge, en largeur, autour d'un volet qui s'ouvre ou se ferme
const EFFECT_AREA = 0.06 // part de l'écran qu'un clic doit changer pour compter comme une animation
const ANIMATION = 0.8 // durée supposée d'une animation, quand l'enregistrement ne l'a pas mesurée
const NAVIGATION = 1.5 // délai entre un clic et le changement d'URL qu'il provoque
const KEEP_SHOT = 0.85 // un plan s'élargit pour un geste tant qu'il garde 85 % de son zoom…
const FIT_GESTURE = 0.75 // …et 75 % du zoom que ce geste aurait seul
const TRANSITION = { min: 0.7, max: 1.0, extra: 0.3 } // durée d'un changement de plan
const PUSH = 0.005
const OUTRO_AFTER = 0.8 // la vue entière finale suit le dernier geste
const CLOSE = { after: 0.15, in: 0.8, out: 0.9, push: 0.02 }

const overlaps = (a: Box, b: Box) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

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
	/** Le volet, dialogue ou section où a lieu le geste, à montrer entier si possible. */
	container?: Box
	click?: Click
	/** Le geste commence par une bulle: la caméra doit être en place avant elle. */
	note?: number
	/** Le clic change de page: ce qui suit est un autre endroit, filmé dans un autre plan. */
	navigation?: boolean
	/** Les barres de la page au moment du geste. */
	bars?: Edges
	/** La barre d'actions flottante visible au moment du geste. */
	toolbar?: Box
}

export function beats(timeline: Timeline): Beat[] {
	const { width, height } = timeline.viewport
	const out: Beat[] = []
	let note: Note | undefined
	let current: Beat | undefined
	/**
	 * Un geste sans conteneur titré (une barre flottante, un bouton posé sur une carte) reste dans
	 * celui du geste précédent s'il se trouve dessus: on n'a pas changé d'endroit.
	 */
	let place: Box | undefined
	const settle = (beat: Beat | undefined) => {
		if (!beat) return
		if (beat.container) place = beat.container
		else if (place && overlaps(beat.box, place)) beat.container = place
	}
	for (const e of timeline.events) {
		if (e.type === 'url') {
			// Un clic qui change de page anime tout l'écran: la mesure de son effet, coupée par la
			// navigation, ne le dit pas.
			if (current?.click && e.t - current.click.t < NAVIGATION) {
				current.effect = { x: 0, y: 0, width, height }
				current.navigation = true
				current.end = Math.max(current.end, e.t + ANIMATION)
			}
			settle(current)
			current = undefined
			place = undefined
		} else if (e.type === 'note') {
			note = e
		} else if (e.type === 'move') {
			settle(current)
			current = {
				t: e.t,
				end: e.end,
				move: e.end - e.t,
				box: { x: e.x, y: e.y, width: 1, height: 1 },
			}
			if (note) {
				current.box = union(current.box, note.box)
				if (note.context) current.box = union(current.box, note.context)
				if (note.container) current.container = note.container
				if (note.bars) current.bars = note.bars
				if (note.toolbar) current.toolbar = note.toolbar
				current.t = Math.min(current.t, note.t)
				current.note = note.t
				note = undefined
			}
			out.push(current)
		} else if (e.type === 'click' && current) {
			if (e.box) current.box = union(current.box, e.box)
			if (e.context) current.box = union(current.box, e.context)
			if (e.container) current.container = e.container
			if (e.bars) current.bars = e.bars
			if (e.toolbar) current.toolbar = e.toolbar
			current.end = Math.max(current.end, e.t + 0.3)
			current.click = e
			if (e.effect && (e.effect.width * e.effect.height) / (width * height) >= EFFECT_AREA) {
				current.effect = e.effect
				current.end = Math.max(current.end, e.settled ?? e.t + ANIMATION)
			}
		} else if (e.type === 'type' && current) {
			if (e.box) current.box = union(current.box, e.box)
			if (e.context) current.box = union(current.box, e.context)
			if (e.container) current.container = e.container
			if (e.bars) current.bars = e.bars
			if (e.toolbar) current.toolbar = e.toolbar
			current.end = Math.max(current.end, e.end)
		}
	}
	settle(current)
	// Une bulle restée seule, sans geste après elle, fait un geste à elle seule.
	if (note)
		out.push({
			t: note.t,
			end: note.end,
			move: 0,
			box: note.context ? union(note.box, note.context) : note.box,
			container: note.container,
			bars: note.bars,
			toolbar: note.toolbar,
			note: note.t,
		})
	return out
}

export function autoTrack(timeline: Timeline, options: CameraOptions): CameraTrack {
	const { width: vw, height: vh } = timeline.viewport
	const overview: Camera = { x: vw / 2, y: vh / 2, zoom: 1 }

	type Bounds = { x0: number; x1: number; y0: number; y1: number }
	const zoomOf = (b: Bounds) =>
		Math.min(options.maxZoom, vw / (b.x1 - b.x0), vh / (b.y1 - b.y0))
	// Une marge au-delà du bord de la page ne montre rien: le rendu ne filme pas hors de la page.
	const inPage = (b: Bounds): Bounds => ({
		x0: Math.max(0, b.x0),
		x1: Math.min(vw, b.x1),
		y0: Math.max(0, b.y0),
		y1: Math.min(vh, b.y1),
	})

	type Around = { effect?: Box; container?: Box; bars?: Edges; toolbar?: Box }

	/**
	 * Le cadrage qui montre `box`, `effect` en largeur (un volet prend toute la hauteur),
	 * `container` entier avec sa marge, axe par axe, tant que le plan n'y perd pas trop, et la
	 * barre d'actions `toolbar`, quitte à presque reculer jusqu'à la vue entière.
	 */
	const framing = (box: Box, { effect, container, bars, toolbar }: Around = {}): Camera => {
		let b: Bounds = {
			x0: box.x - PAD,
			x1: box.x + box.width + PAD,
			y0: box.y - PAD,
			y1: box.y + box.height + PAD,
		}
		if (effect) {
			// Toute la largeur, du geste au volet: le bouton cliqué et ce qu'il ouvre.
			b.x0 = Math.min(b.x0, effect.x - EFFECT_PAD)
			b.x1 = Math.max(b.x1, effect.x + effect.width + EFFECT_PAD)
		}
		if (bars) {
			// La marge autour du geste ne déborde pas sur une barre, qui restera hors du cadre.
			if (box.y >= bars.top) b.y0 = Math.max(b.y0, bars.top)
			if (box.x >= bars.left) b.x0 = Math.max(b.x0, bars.left)
			if (box.y + box.height <= vh - bars.bottom) b.y1 = Math.min(b.y1, vh - bars.bottom)
			if (box.x + box.width <= vw - bars.right) b.x1 = Math.min(b.x1, vw - bars.right)
		}
		let whole = false
		if (container) {
			const cx = {
				x0: Math.min(b.x0, container.x - CONTAINER_PAD),
				x1: Math.max(b.x1, container.x + container.width + CONTAINER_PAD),
			}
			const cy = {
				y0: Math.min(b.y0, container.y - CONTAINER_PAD),
				y1: Math.max(b.y1, container.y + container.height + CONTAINER_PAD),
			}
			if (zoomOf({ ...b, ...cx }) >= CONTAINER_ZOOM) b = { ...b, ...cx }
			if (zoomOf({ ...b, ...cy }) >= CONTAINER_ZOOM) b = { ...b, ...cy }
			whole =
				b.x0 <= container.x &&
				b.x1 >= container.x + container.width &&
				b.y0 <= container.y &&
				b.y1 >= container.y + container.height
		}
		// Un conteneur montré entier justifie un plan peu zoomé: il rapproche une carte, pas des marges.
		let floor = whole ? CONTAINER_ZOOM : MIN_ZOOM
		if (toolbar) {
			const t = inPage({
				x0: Math.min(b.x0, toolbar.x - TOOLBAR_PAD),
				x1: Math.max(b.x1, toolbar.x + toolbar.width + TOOLBAR_PAD),
				y0: Math.min(b.y0, toolbar.y - TOOLBAR_PAD),
				y1: Math.max(b.y1, toolbar.y + toolbar.height + TOOLBAR_PAD),
			})
			if (zoomOf(t) >= TOOLBAR_ZOOM) {
				b = t
				floor = TOOLBAR_ZOOM
			}
		}
		b = inPage(b)
		const zoom = zoomOf(b)
		if (zoom < floor) return overview
		return clearOfBars(b, zoom, bars)
	}

	/**
	 * Un bord de cadre qui tomberait dans une barre de la page (en-tête, barre latérale) la
	 * trancherait: le cadre glisse pour la laisser dehors, tant que ce qu'il montre y tient encore;
	 * sinon il la prend entière, jusqu'au bord de la page.
	 */
	const clearOfBars = (b: Bounds, zoom: number, bars?: Edges): Camera => {
		const axis = (
			center: number,
			size: number,
			page: number,
			[lo, hi]: [number, number],
			[start, end]: [number, number]
		) => {
			const near = center - size / 2
			const far = center + size / 2
			if (near > 0 && near < start) {
				if (hi <= start + size) return start + size / 2
				if (hi <= size) return size / 2
			} else if (far < page && far > page - end) {
				if (lo >= page - end - size) return page - end - size / 2
				if (lo >= page - size) return page - size / 2
			}
			return center
		}
		const w = vw / zoom
		const h = vh / zoom
		return {
			x: axis((b.x0 + b.x1) / 2, w, vw, [b.x0, b.x1], [bars?.left ?? 0, bars?.right ?? 0]),
			y: axis((b.y0 + b.y1) / 2, h, vh, [b.y0, b.y1], [bars?.top ?? 0, bars?.bottom ?? 0]),
			zoom,
		}
	}

	// --- plans: un par contexte ----------------------------------------------------------------
	type Group = { beats: Beat[]; box: Box; effect?: Box; container?: Box; cam: Camera }
	const groups: Group[] = []
	for (const beat of beats(timeline)) {
		const alone = framing(beat.box, beat)
		const last = groups.at(-1)
		if (last && !last.beats.at(-1)?.navigation) {
			const box = union(last.box, beat.box)
			const effect =
				last.effect && beat.effect ? union(last.effect, beat.effect) : (last.effect ?? beat.effect)
			const container =
				last.container && beat.container
					? union(last.container, beat.container)
					: (last.container ?? beat.container)
			const cam = framing(box, { effect, container, bars: beat.bars, toolbar: beat.toolbar })
			// Le plan accueille le geste s'il ne doit pas trop reculer pour cela, si le geste n'y
			// paraît pas trop petit, et sans devenir la vue entière: un plan serré qui la rejoint
			// n'est plus le même plan.
			const widened = cam.zoom === 1 && last.cam.zoom > 1
			if (
				!widened &&
				cam.zoom >= last.cam.zoom * KEEP_SHOT &&
				cam.zoom >= alone.zoom * FIT_GESTURE
			) {
				Object.assign(last, { box, effect, container, cam })
				last.beats.push(beat)
				continue
			}
		}
		groups.push({
			beats: [beat],
			box: beat.box,
			effect: beat.effect,
			container: beat.container,
			cam: alone,
		})
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
