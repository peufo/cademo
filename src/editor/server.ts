import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { defaultRenderOptions, type Timeline } from '../timeline.ts'
import { autoTrack } from '../render/camera.ts'
import type { CameraTrack } from '../track.ts'

/**
 * L'éditeur de caméra: une page locale pour reprendre à la main la piste de plans d'un
 * enregistrement. Elle part de `camera.json` s'il existe pour cette prise, sinon de la caméra
 * automatique, et y enregistre le résultat, que le rendu utilise ensuite.
 *
 * `render`, s'il est fourni, est appelé par le bouton « Rendre » de la page.
 */
export async function startEditor(
	dir: string,
	{ port = 4300, render }: { port?: number; render?: () => Promise<string> } = {}
) {
	const rec = resolve(dir)
	const timelinePath = join(rec, 'timeline.json')
	const cameraPath = join(rec, 'camera.json')
	const videoPath = join(rec, 'raw.mp4')
	if (!existsSync(timelinePath)) throw new Error(`Pas de timeline.json dans ${rec}`)

	const timeline = async (): Promise<Timeline> => Bun.file(timelinePath).json()
	const auto = async () => {
		const t = await timeline()
		return autoTrack(t, { ...defaultRenderOptions, ...t.render })
	}
	const edited = async (): Promise<CameraTrack | null> => {
		if (!existsSync(cameraPath)) return null
		const track: CameraTrack = await Bun.file(cameraPath).json()
		const t = await timeline()
		return Math.abs(track.duration - t.duration) < 0.05 ? track : null
	}

	// La page est assemblée ici plutôt que par l'import HTML de Bun, dont les chemins de fichiers
	// dépendent du dossier d'où l'on lance la commande.
	const built = await Bun.build({
		// `editor.ts` depuis les sources, `editor.js` une fois le paquet compilé.
		entrypoints: [
			join(import.meta.dir, existsSync(join(import.meta.dir, 'editor.ts')) ? 'editor.ts' : 'editor.js'),
		],
		target: 'browser',
	})
	if (!built.success) throw new AggregateError(built.logs, "Échec de l'assemblage de l'éditeur")
	const script = await built.outputs[0].text()
	const html = await Bun.file(join(import.meta.dir, 'editor.html')).text()
	const css = await Bun.file(join(import.meta.dir, 'editor.css')).text()

	const server = Bun.serve({
		port,
		development: false,
		routes: {
			'/': () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
			'/editor.js': () => new Response(script, { headers: { 'Content-Type': 'text/javascript' } }),
			'/editor.css': () => new Response(css, { headers: { 'Content-Type': 'text/css' } }),
			'/api/state': {
				GET: async () =>
					Response.json({
						timeline: await timeline(),
						auto: await auto(),
						edited: await edited(),
						canRender: !!render,
					}),
			},
			'/api/track': {
				POST: async (req) => {
					const track: CameraTrack = await req.json()
					await writeFile(cameraPath, JSON.stringify(track, null, '\t'))
					return Response.json({ ok: true })
				},
				// Revenir à la caméra automatique.
				DELETE: async () => {
					await rm(cameraPath, { force: true })
					return Response.json({ ok: true })
				},
			},
			'/api/render': {
				POST: async () => {
					if (!render) return Response.json({ error: 'Rendu indisponible' }, { status: 400 })
					try {
						return Response.json({ path: await render() })
					} catch (e) {
						return Response.json({ error: (e as Error).message }, { status: 500 })
					}
				},
			},
			'/raw.mp4': (req) => serveVideo(videoPath, req),
			'/favicon.ico': () => new Response(null, { status: 204 }),
		},
	})
	const url = `http://localhost:${server.port}/`
	console.log(`Éditeur de caméra: ${url}  (Ctrl+C pour quitter)`)
	if (!process.env.CADEMO_NO_OPEN) spawn('open', [url], { stdio: 'ignore' }).on('error', () => {})
	return server
}

/** La vidéo, avec les requêtes partielles qu'un `<video>` exige pour se déplacer. */
function serveVideo(path: string, req: Request) {
	const file = Bun.file(path)
	const size = file.size
	const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' }
	const range = req.headers.get('range')?.match(/bytes=(\d*)-(\d*)/)
	if (!range) return new Response(file, { headers: { ...headers, 'Content-Length': String(size) } })
	const start = range[1] ? Number(range[1]) : 0
	const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
	return new Response(file.slice(start, end + 1), {
		status: 206,
		headers: {
			...headers,
			'Content-Range': `bytes ${start}-${end}/${size}`,
			'Content-Length': String(end - start + 1),
		},
	})
}
