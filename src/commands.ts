import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from './config.ts'
import type { Timeline } from './timeline.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** Le point d'entrée Remotion, à côté de ce module (dans `dist/` une fois compilé). */
const renderEntry = join(here, 'render', 'index.js')

export function run(cmd: string, args: string[], cwd?: string) {
	return new Promise<void>((ok, ko) => {
		const child = spawn(cmd, args, { cwd, stdio: 'inherit' })
		child.on('error', ko)
		child.on('exit', (code) =>
			code === 0 ? ok() : ko(new Error(`${cmd} a échoué (code ${code})`))
		)
	})
}

function output(cmd: string, args: string[]) {
	return new Promise<string>((ok, ko) => {
		const child = spawn(cmd, args)
		let s = ''
		child.stdout.on('data', (d) => (s += d))
		child.on('error', ko)
		child.on('exit', () => ok(s))
	})
}

/** Le dossier d'enregistrement d'une démo, qui doit exister. */
export function recording(config: ResolvedConfig, id: string) {
	const dir = join(config.workDir, id)
	if (!existsSync(join(dir, 'timeline.json'))) {
		throw new Error(`La démo « ${id} » n'a pas encore été enregistrée (${relative(config.root, dir)}).`)
	}
	return dir
}

export const videoPath = (config: ResolvedConfig, id: string) => join(config.output, `${id}.mp4`)

// --- enregistrement ------------------------------------------------------------------------------

/**
 * Joue les scénarios (tous, ou ceux nommés) avec le Playwright du projet. La config Playwright est
 * écrite dans le dossier de travail: Playwright la transpile, et elle importe `cademo.config.ts`.
 */
export async function record(config: ResolvedConfig, ids: string[]) {
	const dir = join(config.workDir, '.cademo')
	await mkdir(dir, { recursive: true })
	const file = join(dir, 'playwright.config.ts')
	const configImport = relative(dir, config.file).replace(/\\/g, '/').replace(/\.ts$/, '')
	await writeFile(
		file,
		[
			'// Écrit par cademo à chaque enregistrement: ne pas modifier.',
			`import config from '${configImport.startsWith('.') ? configImport : './' + configImport}'`,
			"import { playwrightConfig } from 'cademo/playwright'",
			'',
			`export default playwrightConfig(config, ${JSON.stringify(config.root)})`,
			'',
		].join('\n')
	)
	const grep = ids.length ? ['-g', ids.map((id) => `(^| )${id}$`).join('|')] : []
	await run('bunx', ['playwright', 'test', '-c', file, ...grep], config.root)
}

// --- rendu ---------------------------------------------------------------------------------------

/** La CLI de Remotion, lancée avec Node: son moteur de rendu ne tourne pas sous Bun. */
const remotion = (args: string[], cwd?: string) => run('node', [remotionCli(), ...args], cwd)

/** Le binaire de `@remotion/cli`, que ses `exports` ne laissent pas résoudre directement. */
function remotionCli() {
	let dir = dirname(fileURLToPath(import.meta.resolve('@remotion/cli')))
	while (!existsSync(join(dir, 'remotion-cli.js')) && dirname(dir) !== dir) dir = dirname(dir)
	return join(dir, 'remotion-cli.js')
}

/** Rend un enregistrement en vidéo finale, avec son poster (la dernière image, le résultat). */
export async function render(recDir: string, target: string, { crf = 23 }: { crf?: number } = {}) {
	await mkdir(dirname(target), { recursive: true })
	await remotion([
		'render', renderEntry, 'Demo', target,
		`--public-dir=${recDir}`,
		`--props=${await propsFile(recDir)}`,
		// Le cache de webpack tient les fichiers de `node_modules` pour immuables à version égale:
		// une mise à jour locale de cademo serait ignorée.
		'--bundle-cache=false',
		`--crf=${crf}`,
		'--codec=h264',
	])
	await run('ffmpeg', ['-v', 'error', '-y', '-sseof', '-0.1', '-i', target, '-frames:v', '1', '-q:v', '3', target.replace(/\.mp4$/, '.jpg')])
	console.log(`✔ ${target}`)
	return target
}

export const renderDemo = (config: ResolvedConfig, id: string) =>
	render(recording(config, id), videoPath(config, id))

/** Une planche de 16 vignettes de la vidéo, et un résumé de la timeline. */
export async function review(config: ResolvedConfig, id: string) {
	const dir = recording(config, id)
	const video = videoPath(config, id)
	const sheet = join(dir, 'review.jpg')
	const duration = Number(
		await output('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video])
	)
	await run('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf', `fps=16/${duration.toFixed(2)},scale=800:-1,tile=4x4`, '-frames:v', '1', sheet])
	const timeline: Timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'))
	const count = (type: string) => timeline.events.filter((e) => e.type === type).length
	console.log(
		`${id}: ${duration.toFixed(1)} s, ${count('click')} clics, ${count('type')} saisies, ${count('note')} bulles`
	)
	console.log(`✔ planche-contact: ${relative(config.root, sheet)}`)
	return sheet
}

/** Enregistre puis rend; sans `ids`, toutes les démos. */
export async function make(
	config: ResolvedConfig,
	ids: string[],
	{ record: doRecord = true, render: doRender = true } = {}
) {
	const startedAt = Date.now()
	if (doRecord) await record(config, ids)
	const fresh = (id: string) => {
		const timeline = join(config.workDir, id, 'timeline.json')
		return existsSync(timeline) && (!doRecord || statSync(timeline).mtimeMs >= startedAt)
	}
	const targets = (ids.length ? ids : recorded(config)).filter(fresh)
	if (!doRender) return
	for (const id of targets) {
		await renderDemo(config, id)
		await review(config, id)
	}
}

/** Les démos déjà enregistrées. */
export function recorded(config: ResolvedConfig) {
	if (!existsSync(config.workDir)) return []
	return readdirSync(config.workDir).filter((id) => existsSync(join(config.workDir, id, 'timeline.json')))
}

/** Les démos écrites: les titres `demo('…')` des fichiers `*.demo.ts`. */
export function scenarios(config: ResolvedConfig) {
	if (!existsSync(config.demos)) return []
	const ids: { id: string; file: string }[] = []
	for (const file of readdirSync(config.demos).filter((f) => /\.demo\.[jt]s$/.test(f))) {
		const source = readFileSync(join(config.demos, file), 'utf8')
		for (const m of source.matchAll(/\bdemo\(\s*(['"`])(.+?)\1/g)) ids.push({ id: m[2], file })
	}
	return ids
}

export function list(config: ResolvedConfig) {
	const rows = scenarios(config)
	if (!rows.length) return console.log(`Aucune démo dans ${relative(config.root, config.demos)}.`)
	for (const { id, file } of rows) {
		const dir = join(config.workDir, id)
		const state = [
			existsSync(join(dir, 'timeline.json')) ? 'enregistrée' : 'à enregistrer',
			existsSync(videoPath(config, id)) ? 'rendue' : null,
			cameraState(dir),
		].filter(Boolean)
		console.log(`${id.padEnd(28)} ${file.padEnd(28)} ${state.join(', ')}`)
	}
}

/** Les props du rendu: la piste éditée, si elle vaut pour cette prise. */
async function propsFile(dir: string) {
	const file = join(dir, '.props.json')
	const track = cameraState(dir) === 'caméra éditée' ? JSON.parse(readFileSync(join(dir, 'camera.json'), 'utf8')) : null
	await writeFile(file, JSON.stringify({ track }))
	return file
}

/**
 * Une piste éditée ne vaut que pour la prise sur laquelle elle a été faite: écrite après elle, et
 * de la même durée. Deux prises d'un même scénario durent souvent à quelques centièmes près.
 */
function cameraState(dir: string) {
	const camera = join(dir, 'camera.json')
	const timelinePath = join(dir, 'timeline.json')
	if (!existsSync(camera) || !existsSync(timelinePath)) return null
	const track = JSON.parse(readFileSync(camera, 'utf8'))
	const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'))
	const after = statSync(camera).mtimeMs >= statSync(timelinePath).mtimeMs
	return after && Math.abs(track.duration - timeline.duration) < 0.05
		? 'caméra éditée'
		: 'caméra éditée sur une ancienne prise (ignorée)'
}

export async function edit(config: ResolvedConfig, id: string) {
	const { startEditor } = await import('./editor/server.ts')
	await startEditor(recording(config, id), { render: () => renderDemo(config, id) })
	// Le serveur tourne jusqu'à Ctrl+C.
	await new Promise(() => {})
}

export async function studio(config: ResolvedConfig, id: string) {
	const dir = recording(config, id)
	await remotion(['studio', renderEntry, `--public-dir=${dir}`, `--props=${await propsFile(dir)}`], config.root)
}
