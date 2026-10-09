import type { CDPSession, Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

type Frame = { file: string; t: number }

/**
 * Filme la page par `Page.startScreencast` de CDP: Chrome envoie une image à chaque repeint, avec
 * son horodatage. La qualité est bien meilleure que `recordVideo` (VP8 à bas débit), et les
 * horodatages permettent de couper ou d'accélérer des passages avant même l'encodage.
 *
 * Chromium seulement.
 */
export class Screencast {
	private cdp?: CDPSession
	private frames: Frame[] = []
	private writes: Promise<unknown>[] = []
	private count = 0
	/** Heure murale du dernier repeint: l'écran est immobile tant qu'elle ne bouge pas. */
	lastFrameAt = 0

	constructor(
		private page: Page,
		private framesDir: string
	) {}

	async start() {
		await rm(this.framesDir, { recursive: true, force: true })
		await mkdir(this.framesDir, { recursive: true })
		this.cdp = await this.page.context().newCDPSession(this.page)
		this.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
			// Acquitter tout de suite: Chrome n'envoie pas l'image suivante avant.
			this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
			const file = join(this.framesDir, `${String(this.count++).padStart(6, '0')}.jpg`)
			const t = metadata.timestamp ?? Date.now() / 1000
			this.lastFrameAt = t
			this.frames.push({ file, t })
			this.writes.push(writeFile(file, Buffer.from(data, 'base64')))
		})
		// Sans taille max, Chrome envoie des images en pixels CSS: on demande la densité réelle.
		const { width, height } = this.page.viewportSize() ?? { width: 1280, height: 800 }
		const dpr = await this.page.evaluate(() => devicePixelRatio)
		await this.cdp.send('Page.startScreencast', {
			format: 'jpeg',
			quality: 92,
			maxWidth: Math.round(width * dpr),
			maxHeight: Math.round(height * dpr),
		})
	}

	async stop() {
		await this.cdp?.send('Page.stopScreencast').catch(() => {})
		await this.cdp?.detach().catch(() => {})
		await Promise.all(this.writes)
		return this.frames
	}
}

/** Fonction croissante qui ramène l'heure murale au temps de la vidéo, passages coupés compris. */
export type TimeMap = (wallTime: number) => number

export type Skip = { from: number; to: number; keep: number }

export function createTimeMap(start: number, skips: Skip[]): TimeMap {
	const sorted = [...skips].sort((a, b) => a.from - b.from)
	return (wall) => {
		let out = wall - start
		for (const { from, to, keep } of sorted) {
			if (wall <= from) break
			const span = to - from
			if (span <= 0) continue
			const inside = Math.min(wall, to) - from
			out -= inside - (inside / span) * Math.min(keep, span)
		}
		return Math.max(0, out)
	}
}

/**
 * La liste du démultiplexeur concat de ffmpeg: chaque image dure jusqu'à la suivante, dans le temps
 * de la vidéo. Une image tombée entièrement dans un passage coupé disparaît.
 */
async function concatList(
	frames: Frame[],
	{ start, end, map, fps, path }: { start: number; end: number; map: TimeMap; fps: number; path: string }
) {
	// L'image affichée au démarrage est la dernière reçue avant lui.
	const firstIndex = Math.max(
		0,
		frames.findLastIndex((f) => f.t <= start)
	)
	const kept = frames.slice(firstIndex).filter((f) => f.t < end)
	if (!kept.length) throw new Error('Aucune image capturée')

	const lines: string[] = []
	for (let i = 0; i < kept.length; i++) {
		const from = map(Math.max(kept[i].t, start))
		const to = map(i + 1 < kept.length ? kept[i + 1].t : end)
		const duration = to - from
		if (duration <= 0.0005) continue
		lines.push(`file '${kept[i].file}'`, `duration ${duration.toFixed(6)}`)
	}
	// Le démultiplexeur concat ignore la durée de la dernière entrée: on la répète, et `-t` coupe
	// ce qu'elle ajouterait.
	lines.push(lines.at(-2)!, `duration ${(1 / fps).toFixed(6)}`)
	await writeFile(path, lines.join('\n'))
}

/** Assemble les images en une vidéo à cadence fixe. */
export async function encodeFrames(
	frames: Frame[],
	{ start, end, map, out, fps = 60 }: { start: number; end: number; map: TimeMap; out: string; fps?: number }
) {
	const list = out + '.txt'
	await concatList(frames, { start, end, map, fps, path: list })
	await run('ffmpeg', [
		'-y',
		'-loglevel', 'error',
		'-f', 'concat',
		'-safe', '0',
		'-i', list,
		'-t', map(end).toFixed(3),
		'-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
		'-c:v', 'libx264',
		'-preset', 'veryfast',
		'-crf', '14',
		// Une image clé par demi-seconde: l'éditeur se déplace dans la vidéo sans attendre.
		'-g', '30',
		'-movflags', '+faststart',
		out,
	])
	await rm(list)
}

/**
 * Les passages où l'image ne change pas, en heure murale. Couper dedans ne se voit pas: c'est là,
 * et seulement là, que l'enregistrement raccourcit les attentes. Le clignement d'un curseur de
 * saisie reste sous le seuil de bruit.
 */
export async function frozenRanges(
	frames: Frame[],
	{ start, end, dir }: { start: number; end: number; dir: string }
) {
	const list = join(dir, 'freeze.txt')
	await concatList(frames, { start, end, map: (t) => t - start, fps: 30, path: list })
	const log = await new Promise<string>((resolve, reject) => {
		const child = spawn('ffmpeg', [
			'-hide_banner',
			'-f', 'concat',
			'-safe', '0',
			'-i', list,
			'-t', (end - start).toFixed(3),
			'-vf', 'fps=30,scale=640:-2,freezedetect=n=0.002:d=0.2',
			'-f', 'null',
			'-',
		])
		let err = ''
		child.stderr.on('data', (d) => (err += d))
		child.on('error', reject)
		child.on('exit', () => resolve(err))
	})
	await rm(list)
	const starts = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]))
	const ends = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => Number(m[1]))
	// Un gel qui dure jusqu'à la fin n'a pas de `freeze_end`.
	return starts.map((from, i) => ({ from: start + from, to: start + (ends[i] ?? end - start) }))
}

export function run(cmd: string, args: string[]) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
		child.on('error', reject)
		child.on('exit', (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} a échoué (code ${code})`))
		)
	})
}
