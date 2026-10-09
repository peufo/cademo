import type { RenderOptions, Timeline } from '../timeline.ts'
import type { Camera } from './camera.ts'

export type Layout = ReturnType<typeof createLayout>

/**
 * Place la fenêtre du navigateur dans la scène, puis passe des coordonnées du viewport filmé à
 * celles de la scène pour un cadrage donné.
 */
export function createLayout(timeline: Timeline, options: RenderOptions) {
	const { width: W, height: H } = options
	const { width: vw, height: vh } = timeline.viewport
	const framed = options.frame === 'window'
	const chrome = framed && options.browserChrome ? Math.round(H * 0.045) : 0
	const margin = framed ? Math.round(Math.min(W, H) * 0.07) : 0
	// Plein cadre: la page couvre l'image; en fenêtre: elle y tient entière.
	const k = framed
		? Math.min((W - 2 * margin) / vw, (H - 2 * margin - chrome) / vh)
		: Math.max(W / vw, H / vh)
	const cw = vw * k
	const ch = vh * k
	const x0 = (W - cw) / 2
	const y0 = (H - ch - chrome) / 2
	const win = { x: x0, y: y0, width: cw, height: ch + chrome }
	const content = { x: x0, y: y0 + chrome, width: cw, height: ch }

	/** Décalage de la scène pour un cadrage, borné pour que la fenêtre ne découvre jamais le fond. */
	function offset(cam: Camera) {
		const z = cam.zoom
		const fx = content.x + cam.x * k
		const fy = content.y + cam.y * k
		const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
		return {
			x: clamp(W / 2 - fx * z, (win.x + win.width) * (1 - z), win.x * (1 - z)),
			y: clamp(H / 2 - fy * z, (win.y + win.height) * (1 - z), win.y * (1 - z)),
		}
	}

	return {
		framed,
		W,
		H,
		k,
		chrome,
		win,
		content,
		offset,
		/** Un point du viewport, en coordonnées de la scène. */
		project(cam: Camera, p: { x: number; y: number }) {
			const o = offset(cam)
			return {
				x: (content.x + p.x * k) * cam.zoom + o.x,
				y: (content.y + p.y * k) * cam.zoom + o.y,
			}
		},
	}
}
