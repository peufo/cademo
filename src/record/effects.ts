import { spawn } from 'node:child_process'
import type { Box, TimelineEvent } from '../timeline.ts'

// Une image réduite en niveaux de gris suffit à voir ce qui change, et se compare vite.
const W = 160
const H = 100
const FPS = 10
export const THRESHOLD = { value: 60 } // écart de luminosité qui compte: au-dessus de l’assombrissement d’un fond de volet
const MIN_AREA = 0.03 // en dessous de cette part de l'image, le clic n'a rien déclenché de notable
const SETTLE = 1.0 // le temps qu'un volet s'ouvre ou qu'une page arrive

function grayFrames(video: string) {
	return new Promise<Buffer>((resolve, reject) => {
		const child = spawn('ffmpeg', [
			'-v', 'error',
			'-i', video,
			'-vf', `fps=${FPS},scale=${W}:${H},format=gray`,
			'-f', 'rawvideo',
			'-',
		])
		const chunks: Buffer[] = []
		child.stdout.on('data', (d) => chunks.push(d))
		child.on('error', reject)
		child.on('exit', (code) =>
			code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg a échoué'))
		)
	})
}

/** La boîte de ce qui a changé entre deux images, en px du viewport, ou `null` si presque rien. */
function changedBox(a: Buffer, b: Buffer, viewport: { width: number; height: number }): Box | null {
	const cols = new Array(W).fill(0)
	const rows = new Array(H).fill(0)
	let count = 0
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = y * W + x
			if (Math.abs(a[i] - b[i]) > THRESHOLD.value) {
				cols[x]++
				rows[y]++
				count++
			}
		}
	}
	if (count / (W * H) < MIN_AREA) return null
	// Une colonne ou une ligne isolée (anti-crénelage, curseur de saisie) ne compte pas.
	const first = (list: number[]) => list.findIndex((n) => n >= 2)
	const last = (list: number[]) => list.findLastIndex((n) => n >= 2)
	const [x0, x1, y0, y1] = [first(cols), last(cols), first(rows), last(rows)]
	if (x0 < 0 || y0 < 0) return null
	const sx = viewport.width / W
	const sy = viewport.height / H
	return { x: x0 * sx, y: y0 * sy, width: (x1 - x0 + 1) * sx, height: (y1 - y0 + 1) * sy }
}

/**
 * Note sur chaque clic la zone de l'écran qu'il a fait changer (`effect`): un volet qui s'ouvre,
 * un dialogue qui se ferme, une page qui arrive. La caméra s'en sert pour reculer et montrer la
 * transition en entier plutôt que de rester collée au bouton.
 */
export async function detectClickEffects(
	video: string,
	events: TimelineEvent[],
	viewport: { width: number; height: number },
	duration: number
) {
	const frames = await grayFrames(video)
	const size = W * H
	const count = Math.floor(frames.length / size)
	const frame = (t: number) => {
		const i = Math.min(count - 1, Math.max(0, Math.round(t * FPS)))
		return frames.subarray(i * size, (i + 1) * size)
	}
	/** Part de l'image qui change entre deux images successives. */
	const motion = (a: Buffer, b: Buffer) => {
		let n = 0
		for (let i = 0; i < size; i++) if (Math.abs(a[i] - b[i]) > THRESHOLD.value / 2) n++
		return n / size
	}
	for (const e of events) {
		if (e.type !== 'click') continue
		const effect = changedBox(frame(e.t - 0.05), frame(Math.min(duration, e.t + SETTLE)), viewport)
		if (!effect) continue
		e.effect = effect
		// La fin de l'animation: deux pas de suite où presque rien ne bouge.
		let calm = 0
		for (let t = e.t + 1 / FPS; t < Math.min(duration, e.t + 2); t += 1 / FPS) {
			calm = motion(frame(t - 1 / FPS), frame(t)) < 0.003 ? calm + 1 : 0
			if (calm >= 2) {
				e.settled = t - 1 / FPS
				break
			}
		}
	}
}
