import type { Locator, Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Box, CursorKind, Edges, RenderOptions, Timeline, TimelineEvent } from '../timeline.ts'
import { detectClickEffects } from './effects.ts'
import { Screencast, createTimeMap, encodeFrames, frozenRanges, type Skip } from './screencast.ts'

export type DirectorOptions = {
	id: string
	/** Dossier de l'enregistrement: `raw.mp4` et `timeline.json` y sont écrits. */
	outDir: string
	title?: string
	render?: Partial<RenderOptions>
	/**
	 * Image figée gardée entre deux gestes, en secondes. Au-delà (attente d'un `expect`, d'une
	 * réponse du serveur), le film raccourcit l'attente — mais seulement tant que rien ne bouge à
	 * l'écran: une animation n'est jamais coupée, et la coupe ne se voit pas. `pause()` n'est jamais
	 * raccourcie.
	 */
	idle?: number
}

type Target = Locator | { x: number; y: number }

/** Un évènement de la timeline, daté en heure murale tant que l'enregistrement n'est pas fini. */
type WallEvent = TimelineEvent

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now() / 1000
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

/**
 * Joue un scénario comme le ferait une personne (souris qui se déplace, frappe au clavier
 * irrégulière, défilement doux) et note chaque geste, pour que le rendu sache où cadrer et où
 * dessiner le curseur.
 *
 * Seul l'intervalle entre `start()` et `stop()` est filmé: tout ce qui précède (données, connexion,
 * navigation initiale) reste hors champ.
 */
export class Director {
	private screencast?: Screencast
	private events: WallEvent[] = []
	private skips: Skip[] = []
	/** Les attentes entre deux gestes, en heure murale: candidates au raccourcissement. */
	private idles: { from: number; to: number }[] = []
	private startedAt = 0
	private cursor = { x: 0, y: 0 }
	private cursorStart = { x: 0, y: 0 }
	/** Fin du dernier geste visible, en heure murale. */
	private lastActive = 0
	private onNavigate = (frame: import('@playwright/test').Frame) => {
		if (frame === this.page.mainFrame()) this.push({ type: 'url', t: now(), url: frame.url() })
	}

	constructor(
		readonly page: Page,
		readonly options: DirectorOptions
	) {
		const { width, height } = page.viewportSize() ?? { width: 1280, height: 800 }
		this.cursor = { x: width * 0.62, y: height * 0.68 }
	}

	get recording() {
		return !!this.screencast
	}

	private push(event: WallEvent) {
		if (this.recording) this.events.push(event)
	}

	async start() {
		if (this.screencast) return
		await this.page.mouse.move(this.cursor.x, this.cursor.y)
		this.cursorStart = { ...this.cursor }
		this.screencast = new Screencast(this.page, join(this.options.outDir, 'frames'))
		await this.screencast.start()
		this.startedAt = now()
		this.push({ type: 'url', t: this.startedAt, url: this.page.url() })
		this.page.on('framenavigated', this.onNavigate)
		// Une première image stable avant le premier geste.
		await sleep(400)
		this.lastActive = now()
	}

	/**
	 * Le rythme entre deux gestes: attendre que l'écran ne bouge plus (un volet qui s'ouvre, une
	 * réponse du serveur), puis laisser `breathe` ms à l'œil. Un geste sans effet visible enchaîne
	 * donc vite, un geste qui déclenche une animation attend qu'elle finisse.
	 */
	private async settle(breathe: number) {
		// Le temps que l'interface réagisse et commence à bouger.
		await sleep(100)
		const screencast = this.screencast
		if (screencast) {
			const deadline = Date.now() + 2500
			while (Date.now() < deadline && now() - screencast.lastFrameAt < 0.12) await sleep(25)
		}
		await sleep(breathe)
	}

	/** Appelé juste avant qu'un geste devienne visible: l'attente qui le précède pourra être raccourcie. */
	private compressIdle() {
		if (!this.recording) return
		const to = now()
		if (to - this.lastActive > 0.1) this.idles.push({ from: this.lastActive, to })
	}

	/**
	 * Raccourcit chaque attente à `idle` secondes d'image figée, en ne coupant que dans les
	 * passages où l'image ne change pas.
	 */
	private async idleSkips(frames: Awaited<ReturnType<Screencast['stop']>>, end: number) {
		const keep = this.options.idle ?? 0.1
		const frozen = await frozenRanges(frames, {
			start: this.startedAt,
			end,
			dir: this.options.outDir,
		})
		const skips: Skip[] = []
		for (const idle of this.idles) {
			for (const f of frozen) {
				const from = Math.max(idle.from, f.from)
				const to = Math.min(idle.to, f.to)
				// On garde la moitié du temps figé au début, l'autre à la fin: l'œil a le temps de
				// voir le résultat du geste précédent, puis la main repart.
				if (to - from > keep + 0.1) skips.push({ from: from + keep / 2, to: to - keep / 2, keep: 0 })
			}
		}
		return skips
	}

	private active() {
		this.lastActive = now()
	}

	/** Arrête le film et écrit `raw.mp4` et `timeline.json`. Sans effet si rien n'a été filmé. */
	async stop({ hold = 800 }: { hold?: number } = {}) {
		if (!this.screencast) return
		await sleep(hold)
		const end = now()
		this.page.off('framenavigated', this.onNavigate)
		const frames = await this.screencast.stop()
		this.screencast = undefined
		const filmed = end - this.startedAt
		console.log(
			`capture ${this.options.id}: ${frames.length} images en ${filmed.toFixed(1)} s ` +
				`(${(frames.length / filmed).toFixed(0)} i/s)`
		)

		const { outDir } = this.options
		await mkdir(outDir, { recursive: true })
		const map = createTimeMap(this.startedAt, [
			...this.skips,
			...(await this.idleSkips(frames, end)),
		])
		await encodeFrames(frames, {
			start: this.startedAt,
			end,
			map,
			out: join(outDir, 'raw.mp4'),
		})
		await rm(join(outDir, 'frames'), { recursive: true, force: true })
		// Pour diagnostiquer la cadence: l'instant de chaque image, en temps de la vidéo.
		await writeFile(
			join(outDir, 'frames.json'),
			JSON.stringify(frames.map((f) => +map(f.t).toFixed(3)))
		)

		const events = this.events.map((e) => {
			const mapped = { ...e, t: map(e.t) }
			if ('end' in mapped) mapped.end = map(mapped.end)
			return mapped
		})
		const viewport = this.page.viewportSize() ?? { width: 1280, height: 800 }
		await detectClickEffects(join(outDir, 'raw.mp4'), events, viewport, map(end))
		const timeline: Timeline = {
			id: this.options.id,
			title: this.options.title,
			viewport,
			duration: map(end),
			cursorStart: this.cursorStart,
			events,
			render: this.options.render ?? {},
		}
		await writeFile(join(outDir, 'timeline.json'), JSON.stringify(timeline, null, '\t'))
		return timeline
	}

	/** Options de rendu propres à cette vidéo, par-dessus celles du projet. */
	render(options: Partial<RenderOptions>) {
		this.options.render = { ...this.options.render, ...options }
	}

	// --- gestes -----------------------------------------------------------------------------

	/** Amène la souris sur la cible par une trajectoire douce, en passant réellement dessus. */
	async moveTo(target: Target, { duration }: { duration?: number } = {}) {
		const point = 'x' in target ? target : center(await this.reveal(target))
		const from = { ...this.cursor }
		const distance = Math.hypot(point.x - from.x, point.y - from.y)
		if (distance < 1) return point
		// Une main posée, qui sait où elle va sans se presser.
		const ms = duration ?? Math.min(1000, 380 + distance * 0.5)
		this.compressIdle()
		const t = now()
		const steps = Math.max(4, Math.round(ms / 16))
		for (let i = 1; i <= steps; i++) {
			const k = easeInOut(i / steps)
			await this.page.mouse.move(from.x + (point.x - from.x) * k, from.y + (point.y - from.y) * k)
			const late = t * 1000 + (i * ms) / steps - Date.now()
			if (late > 0) await sleep(late)
		}
		this.cursor = { ...point }
		const cursor = await this.cursorAt(point)
		this.push({ type: 'move', t, end: now(), x: point.x, y: point.y, cursor })
		this.active()
		return point
	}

	async hover(target: Locator, { pause = 600 }: { pause?: number } = {}) {
		await this.moveTo(target)
		await sleep(pause)
		this.active()
	}

	/**
	 * `closeUp`: la caméra plonge sur ce clic. `pause`: temps fixe après le clic, à la place de
	 * l'attente adaptative (écran immobile puis un souffle).
	 */
	async click(
		target: Locator,
		{ pause, note, closeUp }: { pause?: number; note?: string; closeUp?: boolean } = {}
	) {
		const box = await this.reveal(target)
		const point = await this.moveTo(center(box))
		const context = await this.contextOf(target)
		if (note) this.push({ ...noteEvent(box, note, 1.6), ...context })
		await sleep(100)
		this.push({ type: 'click', t: now(), x: point.x, y: point.y, box, closeUp, ...context })
		await this.page.mouse.down()
		await sleep(70)
		await this.page.mouse.up()
		if (pause === undefined) await this.settle(200)
		else await sleep(pause)
		this.active()
	}

	/** Clique dans le champ puis tape le texte, à une cadence humaine. */
	async type(
		target: Locator,
		text: string,
		{ cps = 14, clear = false, pause }: { cps?: number; clear?: boolean; pause?: number } = {}
	) {
		await this.click(target, { pause: 120, closeUp: false })
		if (clear) {
			await this.page.keyboard.press('ControlOrMeta+A')
			await this.page.keyboard.press('Backspace')
		}
		const box = await target.boundingBox()
		const t = now()
		for (const char of text) {
			await this.page.keyboard.type(char)
			const base = 1000 / cps
			await sleep(base * (0.6 + Math.random() * 0.8) + (char === ' ' ? base * 0.5 : 0))
		}
		this.push({ type: 'type', t, end: now(), box, ...(await this.contextOf(target)) })
		if (pause === undefined) await this.settle(100)
		else await sleep(pause)
		this.active()
	}

	/**
	 * Presse sur `from`, glisse jusqu'à `to` à la vitesse d'une main qui trace, et relâche: tracer
	 * une plage, déplacer une carte. Pour la caméra, c'est un clic dont la cible couvre le trajet.
	 */
	async drag(
		from: Target,
		to: Target,
		{ duration = 900, pause }: { duration?: number; pause?: number } = {}
	) {
		const start = await this.moveTo(from)
		const end = 'x' in to ? to : center(await this.reveal(to))
		const context = 'x' in from ? {} : await this.contextOf(from)
		const box = {
			x: Math.min(start.x, end.x),
			y: Math.min(start.y, end.y),
			width: Math.abs(end.x - start.x) || 1,
			height: Math.abs(end.y - start.y) || 1,
		}
		await sleep(100)
		this.push({ type: 'click', t: now(), x: start.x, y: start.y, box, ...context })
		await this.page.mouse.down()
		await sleep(120)
		await this.moveTo(end, { duration })
		await sleep(120)
		await this.page.mouse.up()
		if (pause === undefined) await this.settle(200)
		else await sleep(pause)
		this.active()
	}

	async press(key: string, { pause }: { pause?: number } = {}) {
		this.compressIdle()
		await this.page.keyboard.press(key)
		if (pause === undefined) await this.settle(250)
		else await sleep(pause)
		this.active()
	}

	/** Choisit une option d'un `<select>` natif, dont la liste ne s'affiche pas dans le film. */
	async select(target: Locator, value: string | { label: string }, { pause }: { pause?: number } = {}) {
		await this.click(target, { pause: 200 })
		await target.selectOption(value)
		await this.page.keyboard.press('Escape').catch(() => {})
		if (pause === undefined) await this.settle(250)
		else await sleep(pause)
		this.active()
	}

	/** Fait défiler la page jusqu'à la cible, en douceur. */
	async scrollTo(target: Locator, { pause = 300 }: { pause?: number } = {}) {
		await target.waitFor({ state: 'visible' })
		this.compressIdle()
		await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }))
		await waitStable(target)
		await sleep(pause)
		this.active()
	}

	/** Un temps voulu (laisser voir un résultat): jamais coupé au montage. */
	async pause(ms: number) {
		this.compressIdle()
		await sleep(ms)
		this.active()
	}

	/**
	 * Impose le cadrage jusqu'au prochain `focus`: une cible, `null` pour la vue entière, `'auto'`
	 * pour rendre la main à la caméra automatique.
	 */
	async focus(target: Locator | null | 'auto', { scale }: { scale?: number } = {}) {
		const box = target === null || target === 'auto' ? target : await this.reveal(target)
		this.push({ type: 'focus', t: now(), box, scale })
	}

	/**
	 * Une bulle d'annotation près de la cible, affichée `ms`. Le scénario reprend après `wait` ms
	 * (par défaut un peu plus de la moitié): le geste suivant commence pendant que la bulle est
	 * encore là, le temps de la lire sans attendre pour rien.
	 */
	async note(
		target: Locator,
		text: string,
		{
			ms = 1700,
			wait = 1000,
			placement,
		}: { ms?: number; wait?: number; placement?: 'top' | 'bottom' | 'left' | 'right' } = {}
	) {
		const box = await this.reveal(target)
		const context = await this.contextOf(target)
		this.compressIdle()
		this.push({ ...noteEvent(box, text, ms / 1000), placement, ...context })
		await sleep(Math.min(wait, ms))
		this.active()
	}

	/** Ce qui se passe dans `fn` est ramené à `keep` secondes dans la vidéo (chargements, attentes). */
	async skip<T>(fn: () => Promise<T>, { keep = 0.25 }: { keep?: number } = {}) {
		this.compressIdle()
		const from = now()
		try {
			return await fn()
		} finally {
			if (this.recording) this.skips.push({ from, to: now(), keep })
			this.active()
		}
	}

	/** Navigation, chargement coupé au montage. */
	async goto(url: string, { ready }: { ready?: (page: Page) => Promise<unknown> } = {}) {
		await this.skip(async () => {
			await this.page.goto(url)
			await ready?.(this.page)
		})
	}

	// --- outils -----------------------------------------------------------------------------

	/** Attend la cible, la fait défiler dans la vue si besoin et rend sa boîte. */
	private async reveal(target: Locator): Promise<Box> {
		await target.waitFor({ state: 'visible' })
		const visible = await target.evaluate((el) => {
			const r = el.getBoundingClientRect()
			return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
		})
		if (!visible) {
			await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }))
		}
		return waitStable(target)
	}

	/**
	 * Le conteneur titré de la cible (dialogue, volet, section, formulaire) et son titre: le titre
	 * dit où l'on est, le conteneur se montre entier avec sa marge. Le plus proche l'emporte.
	 */
	private async contextOf(
		target: Locator
	): Promise<{ context?: Box; container?: Box; bars?: Edges; toolbar?: Box }> {
		return target
			.evaluate((el) => {
				// Les barres de la page: un repère posé contre un bord (à sa marge près), qui en couvre
				// au moins la moitié.
				const edge = 16
				const bars = { top: 0, right: 0, bottom: 0, left: 0 }
				const landmarks =
					'header, footer, nav, aside, [role=banner], [role=navigation], [role=contentinfo]'
				for (const bar of document.querySelectorAll(landmarks)) {
					const r = bar.getBoundingClientRect()
					if (r.width === 0 || r.height === 0) continue
					const wide = r.width >= innerWidth / 2 && r.height <= innerHeight / 4
					const tall = r.height >= innerHeight / 2 && r.width <= innerWidth / 4
					if (wide && r.top <= edge) bars.top = Math.max(bars.top, r.bottom)
					if (wide && r.bottom >= innerHeight - edge)
						bars.bottom = Math.max(bars.bottom, innerHeight - r.top)
					if (tall && r.left <= edge) bars.left = Math.max(bars.left, r.right)
					if (tall && r.right >= innerWidth - edge)
						bars.right = Math.max(bars.right, innerWidth - r.left)
				}
				// La barre d'actions flottante: fixée à l'écran et porteuse d'un bouton, hors des
				// notifications, des dialogues et des repères de page. Masquée par un dialogue ouvert.
				let toolbar: { x: number; y: number; width: number; height: number } | undefined
				const modal = document.querySelector('dialog[open], [aria-modal=true]')
				const excluded =
					'dialog, [role=dialog], [aria-live], [role=status], [role=alert], [role=log], ' + landmarks
				const seen = new Set<Element>()
				for (const button of modal ? [] : document.querySelectorAll('button')) {
					let fixed: Element | null = button
					while (fixed && getComputedStyle(fixed).position !== 'fixed') fixed = fixed.parentElement
					if (!fixed || seen.has(fixed) || fixed.closest(excluded)) continue
					seen.add(fixed)
					const r = fixed.getBoundingClientRect()
					if (r.width === 0 || r.height === 0 || r.width * r.height > innerWidth * innerHeight / 4)
						continue
					if (r.bottom <= 0 || r.top >= innerHeight) continue
					const b = toolbar ?? { x: r.x, y: r.y, width: r.width, height: r.height }
					const x = Math.min(b.x, r.x)
					const y = Math.min(b.y, r.y)
					toolbar = {
						x,
						y,
						width: Math.max(b.x + b.width, r.right) - x,
						height: Math.max(b.y + b.height, r.bottom) - y,
					}
				}
				const containers =
					'dialog, [role=dialog], [role=alertdialog], [aria-modal=true], aside, section, fieldset, form, article'
				const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height })
				for (let c = el.closest(containers); c; c = c.parentElement?.closest(containers) ?? null) {
					const labelledBy = c.getAttribute('aria-labelledby')
					const title =
						(labelledBy && document.getElementById(labelledBy.split(' ')[0])) ||
						c.querySelector('h1, h2, h3, h4, [role=heading], legend')
					const r = title?.getBoundingClientRect()
					if (!r || r.width === 0 || r.height === 0) continue
					// Borné au viewport: une section plus haute que l'écran n'y entre que par sa partie
					// visible.
					const b = c.getBoundingClientRect()
					const x = Math.max(0, b.x)
					const y = Math.max(0, b.y)
					const right = Math.min(innerWidth, b.right)
					const bottom = Math.min(innerHeight, b.bottom)
					const container =
						right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined
					return { context: box(r), container, bars, toolbar }
				}
				return { bars, toolbar }
			})
			.catch(() => ({}))
	}

	private async cursorAt({ x, y }: { x: number; y: number }): Promise<CursorKind> {
		return this.page
			.evaluate(
				([x, y]) => {
					const el = document.elementFromPoint(x, y)
					if (!el) return 'arrow'
					const cursor = getComputedStyle(el).cursor
					if (cursor === 'pointer') return 'pointer'
					if (cursor === 'text') return 'text'
					if (cursor !== 'auto') return 'arrow'
					const textual =
						el instanceof HTMLTextAreaElement ||
						(el instanceof HTMLInputElement &&
							/^(text|email|search|url|tel|password|number|)$/.test(el.type)) ||
						(el as HTMLElement).isContentEditable
					return textual ? 'text' : 'arrow'
				},
				[x, y] as const
			)
			.catch(() => 'arrow' as const)
	}
}

function center(box: Box) {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function noteEvent(box: Box, text: string, seconds: number): TimelineEvent & { type: 'note' } {
	const t = now()
	return { type: 'note', t, end: t + seconds, box, text }
}

/** La boîte de la cible, une fois immobile (fin de défilement ou d'animation d'ouverture). */
async function waitStable(target: Locator, timeout = 2000): Promise<Box> {
	const deadline = Date.now() + timeout
	let last = await target.boundingBox()
	let stable = 0
	while (Date.now() < deadline && stable < 3) {
		await sleep(50)
		const box = await target.boundingBox()
		const same =
			box &&
			last &&
			Math.abs(box.x - last.x) < 0.5 &&
			Math.abs(box.y - last.y) < 0.5 &&
			Math.abs(box.width - last.width) < 0.5
		stable = same ? stable + 1 : 0
		last = box
	}
	if (!last) throw new Error(`Cible sans boîte: ${target}`)
	return last
}
