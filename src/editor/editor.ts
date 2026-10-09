import type { Timeline } from '../timeline.ts'
import { evaluateTrack, DEFAULT_PUSH, type Camera, type CameraTrack, type Shot } from '../track.ts'
import { cursorAt } from '../cursor-path.ts'

// --- état ------------------------------------------------------------------------------------

type State = { timeline: Timeline; auto: CameraTrack; edited: CameraTrack | null; canRender: boolean }

const state: State = await fetch('/api/state').then((r) => r.json())
const { timeline } = state
const { width: vw, height: vh } = timeline.viewport
const duration = timeline.duration

let track: CameraTrack = structuredClone(state.edited ?? state.auto)
let evaluator = evaluateTrack(track, timeline.viewport)
let selected: Shot | null = null
let dirty = false
const history: string[] = []

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
// Affecté ici: dans le HTML, le bundler de Bun chercherait le fichier sur le disque.
video.src = '/raw.mp4'
const source = $<HTMLCanvasElement>('source')
const preview = $<HTMLCanvasElement>('preview')
const shotsLane = $('shots')
const eventsLane = $('events')
const ruler = $('ruler')
const playhead = $('playhead')

$('title').textContent = timeline.id
$<HTMLButtonElement>('render').hidden = !state.canRender

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
const round = (v: number, step = 0.05) => Math.round(v / step) * step

/** La zone du viewport montrée par un cadrage, bornée au viewport comme au rendu. */
function crop(cam: Camera) {
	const w = vw / cam.zoom
	const h = vh / cam.zoom
	return { x: clamp(cam.x - w / 2, 0, vw - w), y: clamp(cam.y - h / 2, 0, vh - h), w, h }
}

// --- modifications ---------------------------------------------------------------------------

/** À appeler avant toute modification: permet l'annulation. */
function snapshot() {
	history.push(JSON.stringify(track))
	if (history.length > 200) history.shift()
}

function changed() {
	track.shots.sort((a, b) => a.start - b.start)
	evaluator = evaluateTrack(track, timeline.viewport)
	dirty = true
	refresh()
}

function undo() {
	const last = history.pop()
	if (!last) return
	const index = selected ? track.shots.indexOf(selected) : -1
	track = JSON.parse(last)
	selected = index >= 0 ? (track.shots[index] ?? null) : null
	changed()
}

function select(shot: Shot | null, seek = true) {
	selected = shot
	if (shot && seek && video.paused) {
		// Montrer le cadrage atteint, pas le début de la transition.
		video.currentTime = Math.min(shot.end - 0.02, shot.start + shot.transition)
	}
	refresh()
}

/** Nouveau plan au point de lecture; dans un plan existant, le coupe en deux. */
function addShot() {
	const t = round(video.currentTime)
	snapshot()
	const inside = track.shots.find((s) => t > s.start + 0.1 && t < s.end - 0.1)
	if (inside) {
		const second: Shot = { ...inside, start: t, transition: 0.8 }
		inside.end = t
		track.shots.push(second)
		selected = second
	} else {
		const next = track.shots.filter((s) => s.start > t).sort((a, b) => a.start - b.start)[0]
		const cam = evaluator.at(t)
		const shot: Shot = {
			x: cam.x,
			y: cam.y,
			zoom: Math.max(1.5, cam.zoom),
			start: t,
			end: Math.min(next?.start ?? duration, t + 2),
			transition: 0.8,
			push: DEFAULT_PUSH,
		}
		track.shots.push(shot)
		selected = shot
	}
	changed()
}

function removeShot() {
	if (!selected) return
	snapshot()
	track.shots = track.shots.filter((s) => s !== selected)
	selected = null
	changed()
}

// --- dessin ----------------------------------------------------------------------------------

function fitCanvas(canvas: HTMLCanvasElement) {
	const r = canvas.getBoundingClientRect()
	const w = Math.round(r.width * devicePixelRatio)
	const h = Math.round(r.height * devicePixelRatio)
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w
		canvas.height = h
	}
	return canvas.getContext('2d')!
}

function drawSource(t: number, cam: Camera) {
	const ctx = fitCanvas(source)
	const { width: W, height: H } = source
	const s = W / vw
	ctx.drawImage(video, 0, 0, W, H)

	// Ce que montre la caméra à cet instant.
	const now = crop(cam)
	ctx.setLineDash([6 * devicePixelRatio, 5 * devicePixelRatio])
	ctx.lineWidth = 1.5 * devicePixelRatio
	ctx.strokeStyle = 'rgba(255,255,255,.85)'
	ctx.strokeRect(now.x * s, now.y * s, now.w * s, now.h * s)
	ctx.setLineDash([])

	// Le cadrage du plan choisi, à manipuler.
	if (selected) {
		const r = crop(selected)
		ctx.fillStyle = 'rgba(79,140,255,.12)'
		ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s)
		ctx.lineWidth = 2 * devicePixelRatio
		ctx.strokeStyle = '#4f8cff'
		ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s)
		const k = 7 * devicePixelRatio
		ctx.fillStyle = '#4f8cff'
		for (const [x, y] of corners(r)) ctx.fillRect(x * s - k / 2, y * s - k / 2, k, k)
	}

	const c = cursorAt(timeline, t)
	ctx.fillStyle = '#ff5a5a'
	ctx.beginPath()
	ctx.arc(c.x * s, c.y * s, 4 * devicePixelRatio, 0, Math.PI * 2)
	ctx.fill()
}

function drawPreview(t: number, cam: Camera) {
	const ctx = fitCanvas(preview)
	const { width: W, height: H } = preview
	const r = crop(cam)
	const k = video.videoWidth / vw || 1
	ctx.drawImage(video, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, W, H)

	// Le curseur, à l'échelle de l'image comme au rendu.
	const c = cursorAt(timeline, t)
	const x = ((c.x - r.x) / r.w) * W
	const y = ((c.y - r.y) / r.h) * H
	const size = (24 * W * cam.zoom * c.press) / vw
	ctx.save()
	ctx.translate(x, y)
	ctx.scale(size / 32, size / 32)
	ctx.beginPath()
	ctx.moveTo(1, 1)
	ctx.lineTo(1, 25.5)
	ctx.lineTo(7.2, 19.5)
	ctx.lineTo(11.3, 29.1)
	ctx.lineTo(15.7, 27.2)
	ctx.lineTo(11.7, 17.9)
	ctx.lineTo(20.3, 17.9)
	ctx.closePath()
	ctx.fillStyle = '#111'
	ctx.strokeStyle = '#fff'
	ctx.lineWidth = 2
	ctx.fill()
	ctx.stroke()
	ctx.restore()
}

function corners(r: ReturnType<typeof crop>) {
	return [
		[r.x, r.y],
		[r.x + r.w, r.y],
		[r.x, r.y + r.h],
		[r.x + r.w, r.y + r.h],
	] as const
}

function frame() {
	const t = video.currentTime
	const cam = evaluator.at(t)
	if (video.readyState >= 2) {
		drawSource(t, cam)
		drawPreview(t, cam)
	}
	$('time').textContent = `${t.toFixed(2)} s`
	playhead.style.left = `${(t / duration) * shotsLane.clientWidth}px`
	$('play').textContent = video.paused ? '▶︎' : '❚❚'
	requestAnimationFrame(frame)
}

// --- timeline --------------------------------------------------------------------------------

const pps = () => shotsLane.clientWidth / duration
const timeAt = (e: PointerEvent | MouseEvent) =>
	clamp((e.clientX - shotsLane.getBoundingClientRect().left) / pps(), 0, duration)

function renderLanes() {
	ruler.replaceChildren()
	const step = duration > 30 ? 5 : 1
	for (let s = 0; s <= duration; s += step) {
		const tick = document.createElement('div')
		tick.className = 'tick'
		tick.style.left = `${s * pps()}px`
		tick.textContent = `${s}s`
		ruler.append(tick)
	}

	eventsLane.replaceChildren()
	for (const e of timeline.events) {
		if (e.type !== 'click' && e.type !== 'type' && e.type !== 'note') continue
		const el = document.createElement('div')
		el.className = `ev ${e.type}`
		el.style.left = `${e.t * pps()}px`
		if (e.type !== 'click') el.style.width = `${Math.max(4, (e.end - e.t) * pps())}px`
		el.title = e.type === 'note' ? `bulle: ${e.text}` : e.type === 'click' ? 'clic' : 'saisie'
		eventsLane.append(el)
	}

	shotsLane.replaceChildren()
	for (const shot of track.shots) {
		const el = document.createElement('div')
		el.className = 'shot'
		if (shot.zoom >= 2.5) el.classList.add('close')
		if (shot === selected) el.classList.add('selected')
		el.style.left = `${shot.start * pps()}px`
		el.style.width = `${(shot.end - shot.start) * pps()}px`
		const ramp = document.createElement('div')
		ramp.className = 'ramp'
		ramp.style.width = `${Math.min(shot.end - shot.start, shot.transition) * pps()}px`
		const label = document.createElement('span')
		label.className = 'label'
		label.textContent = `×${shot.zoom.toFixed(2)}`
		const l = document.createElement('div')
		l.className = 'edge l'
		const r = document.createElement('div')
		r.className = 'edge r'
		el.append(ramp, label, l, r)
		el.addEventListener('pointerdown', (e) => startDrag(e, shot, e.target === l ? 'l' : e.target === r ? 'r' : 'move'))
		shotsLane.append(el)
	}
}

function startDrag(e: PointerEvent, shot: Shot, mode: 'l' | 'r' | 'move') {
	e.stopPropagation()
	select(shot, mode === 'move')
	snapshot()
	const t0 = timeAt(e)
	const { start, end } = shot
	// On ne déborde pas sur les plans voisins.
	const others = track.shots.filter((s) => s !== shot)
	const before = Math.max(0, ...others.filter((s) => s.end <= start + 0.001).map((s) => s.end))
	const after = Math.min(duration, ...others.filter((s) => s.start >= end - 0.001).map((s) => s.start))
	let moved = false
	const onMove = (ev: PointerEvent) => {
		const dt = timeAt(ev) - t0
		if (Math.abs(dt) > 0.01) moved = true
		if (mode === 'move') {
			const d = clamp(round(dt), before - start, after - end)
			shot.start = start + d
			shot.end = end + d
		} else if (mode === 'l') shot.start = clamp(round(start + dt), before, end - 0.1)
		else shot.end = clamp(round(end + dt), start + 0.1, after)
		changed()
	}
	const onUp = () => {
		window.removeEventListener('pointermove', onMove)
		window.removeEventListener('pointerup', onUp)
		if (!moved) history.pop()
	}
	window.addEventListener('pointermove', onMove)
	window.addEventListener('pointerup', onUp)
}

for (const lane of [ruler, eventsLane, shotsLane]) {
	lane.addEventListener('pointerdown', (e) => {
		video.currentTime = timeAt(e)
		if (lane === shotsLane) select(null, false)
	})
}
shotsLane.addEventListener('dblclick', (e) => {
	video.currentTime = timeAt(e)
	addShot()
})

// --- manipulation du cadre ---------------------------------------------------------------------

source.addEventListener('pointerdown', (e) => {
	if (!selected) return
	const shot = selected
	const rect = source.getBoundingClientRect()
	const toVp = (ev: PointerEvent) => ({
		x: ((ev.clientX - rect.left) / rect.width) * vw,
		y: ((ev.clientY - rect.top) / rect.height) * vh,
	})
	const p = toVp(e)
	const r = crop(shot)
	const near = 14 * (vw / rect.width)
	const corner = corners(r).some(([x, y]) => Math.hypot(p.x - x, p.y - y) < near)
	const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
	if (!corner && !inside) return
	snapshot()
	// On part du centre réellement montré (le cadre est borné au viewport).
	const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
	shot.x = center.x
	shot.y = center.y
	const onMove = (ev: PointerEvent) => {
		const q = toVp(ev)
		if (corner) {
			const half = Math.max(Math.abs(q.x - center.x), (Math.abs(q.y - center.y) * vw) / vh)
			shot.zoom = clamp(vw / (2 * half), 1, 6)
		} else {
			shot.x = center.x + (q.x - p.x)
			shot.y = center.y + (q.y - p.y)
		}
		const c = crop(shot)
		shot.x = c.x + c.w / 2
		shot.y = c.y + c.h / 2
		changed()
	}
	const onUp = () => {
		window.removeEventListener('pointermove', onMove)
		window.removeEventListener('pointerup', onUp)
	}
	window.addEventListener('pointermove', onMove)
	window.addEventListener('pointerup', onUp)
})

source.addEventListener(
	'wheel',
	(e) => {
		if (!selected) return
		e.preventDefault()
		snapshot()
		selected.zoom = clamp(selected.zoom * Math.exp(-e.deltaY * 0.002), 1, 6)
		const c = crop(selected)
		selected.x = c.x + c.w / 2
		selected.y = c.y + c.h / 2
		changed()
	},
	{ passive: false }
)

// --- inspecteur ------------------------------------------------------------------------------

const fields = ['start', 'end', 'zoom', 'transition', 'push'] as const
for (const name of fields) {
	const input = $<HTMLInputElement>(`f-${name}`)
	input.addEventListener('change', () => {
		if (!selected) return
		const value = Number(input.value)
		if (!Number.isFinite(value)) return
		snapshot()
		selected[name] = name === 'zoom' ? clamp(value, 1, 6) : Math.max(0, value)
		changed()
	})
}
$('overview').addEventListener('click', () => {
	if (!selected) return
	snapshot()
	Object.assign(selected, { x: vw / 2, y: vh / 2, zoom: 1 })
	changed()
})

function refresh() {
	renderLanes()
	$<HTMLButtonElement>('remove').disabled = !selected
	$('hint').hidden = !!selected
	for (const el of $('inspector').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
		el.disabled = !selected
	if (selected) {
		for (const name of fields) {
			const input = $<HTMLInputElement>(`f-${name}`)
			if (document.activeElement !== input) input.value = String(+(selected[name] ?? 0).toFixed(3))
		}
	}
	const badge = $('badge')
	badge.textContent = state.edited || dirty ? 'piste éditée' : 'caméra automatique'
	badge.classList.toggle('edited', !!state.edited || dirty)
	$('status').textContent = dirty ? 'modifications non enregistrées' : ''
}

// --- actions ---------------------------------------------------------------------------------

async function save() {
	await fetch('/api/track', { method: 'POST', body: JSON.stringify({ ...track, duration }) })
	state.edited = structuredClone(track)
	dirty = false
	refresh()
	$('status').textContent = 'enregistré dans camera.json'
}

const togglePlay = () => (video.paused ? video.play() : video.pause())

$('play').addEventListener('click', togglePlay)
$('add').addEventListener('click', addShot)
$('remove').addEventListener('click', removeShot)
$('undo').addEventListener('click', undo)
$('save').addEventListener('click', save)
$('reset').addEventListener('click', async () => {
	if (!confirm('Repartir de la caméra automatique ? La piste éditée sera supprimée.')) return
	await fetch('/api/track', { method: 'DELETE' })
	snapshot()
	track = structuredClone(state.auto)
	state.edited = null
	selected = null
	changed()
	dirty = false
	refresh()
})
$('render').addEventListener('click', async () => {
	if (dirty) await save()
	const button = $<HTMLButtonElement>('render')
	button.disabled = true
	$('status').textContent = 'rendu en cours…'
	const res = await fetch('/api/render', { method: 'POST' }).then((r) => r.json())
	button.disabled = false
	$('status').textContent = res.error ? `échec du rendu: ${res.error}` : `rendu: ${res.path}`
})

window.addEventListener('keydown', (e) => {
	if ((e.target as HTMLElement).tagName === 'INPUT') return
	const meta = e.metaKey || e.ctrlKey
	if (e.key === ' ') {
		e.preventDefault()
		togglePlay()
	} else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
		e.preventDefault()
		const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1)
		video.currentTime = clamp(video.currentTime + step, 0, duration)
	} else if (e.key === 'n' || e.key === 'N') addShot()
	else if (e.key === 'Backspace' || e.key === 'Delete') removeShot()
	else if (meta && e.key === 'z') {
		e.preventDefault()
		undo()
	} else if (meta && e.key === 's') {
		e.preventDefault()
		save()
	} else if (e.key === 'Escape') select(null, false)
	else if (e.key === 'Home') video.currentTime = 0
})
window.addEventListener('beforeunload', (e) => {
	if (dirty) e.preventDefault()
})
window.addEventListener('resize', refresh)

refresh()
requestAnimationFrame(frame)
