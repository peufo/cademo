import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILE, loadConfig } from './config.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

type Report = { done: string[]; kept: string[]; warnings: string[] }

/**
 * Met un projet en place pour cademo. Idempotent: ce qui existe déjà n'est jamais écrasé (sauf le
 * skill, avec `skill: true`).
 */
export async function init(root: string, { skill = false }: { skill?: boolean } = {}) {
	const report: Report = { done: [], kept: [], warnings: [] }

	checkEnvironment(root, report)
	if (!skill) {
		await writeConfig(root, report)
		const config = await loadConfig(root)
		await writeExample(config.demos, root, report)
		await ignoreWorkDir(root, config.workDir, report)
		await addScripts(root, report)
	}
	await installSkill(root, report, skill)
	await prettierIgnoreSkill(root, report)

	for (const line of report.done) console.log(`✔ ${line}`)
	for (const line of report.kept) console.log(`· ${line}`)
	for (const line of report.warnings) console.log(`⚠ ${line}`)
	if (!skill) {
		console.log(`
Ensuite:
  1. Régler ${CONFIG_FILE} (serveur, locale, origine affichée…).
  2. Écrire une démo dans le dossier des démos, ou la demander à Claude Code (skill cademo).
  3. bun run demo <id>        enregistre et rend la vidéo
     bun run demo:edit <id>   reprend la caméra à la main`)
	}
}

function checkEnvironment(root: string, report: Report) {
	if (!Bun.which('ffmpeg')) report.warnings.push('ffmpeg introuvable: l’installer (brew install ffmpeg).')
	if (!existsSync(join(root, 'node_modules/@playwright/test'))) {
		report.warnings.push('@playwright/test absent: bun add -d @playwright/test')
	}
	const caches = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]
	const chromium = caches.some(
		(dir) => existsSync(dir) && readdirSync(dir).some((d) => /^chromium-\d+$/.test(d))
	)
	if (!chromium) report.warnings.push('Chromium pour Playwright absent: bunx playwright install chromium')
}

async function writeConfig(root: string, report: Report) {
	const file = join(root, CONFIG_FILE)
	if (existsSync(file)) return report.kept.push(`${CONFIG_FILE} existe déjà`)
	const playwright = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].find((f) =>
		existsSync(join(root, f))
	)
	// Le dossier servi tel quel par le framework: `static/` (SvelteKit), `public/` (Vite, Next…).
	const output = existsSync(join(root, 'static'))
		? 'static/videos'
		: existsSync(join(root, 'public'))
			? 'public/videos'
			: 'videos'
	const server = playwright
		? `	// Même serveur que les tests.
	webServer: playwright.webServer,
	baseURL: playwright.use?.baseURL,`
		: `	baseURL: 'http://localhost:5173',
	webServer: { command: 'npm run dev', port: 5173, reuseExistingServer: true },`
	await writeFile(
		file,
		`import { defineConfig } from 'cademo'
${playwright ? `import playwright from './${playwright.replace(/\.[mc]?[jt]s$/, '')}'\n` : ''}
export default defineConfig({
	demos: 'demos',
	output: '${output}',
${server}
	// viewport: { width: 1280, height: 800 },
	// locale: 'fr-CH',
	// timezoneId: 'Europe/Zurich',
	// render: { displayOrigin: 'https://mon-app.example' },
})
`
	)
	report.done.push(`${CONFIG_FILE} créé${playwright ? ` (serveur repris de ${playwright})` : ''}`)
}

async function writeExample(demos: string, root: string, report: Report) {
	const has = existsSync(demos) && readdirSync(demos).some((f) => /\.demo\.[jt]s$/.test(f))
	if (has) return report.kept.push('des démos existent déjà')
	await mkdir(demos, { recursive: true })
	await writeFile(
		join(demos, 'example.demo.ts'),
		`import { demo, expect } from 'cademo'

// Une démo est un scénario Playwright; son titre est le nom de la vidéo.
demo('example', async ({ page, director }) => {
	// Hors champ: données, connexion, page de départ.
	await page.goto('/')

	await director.start()
	// Les gestes filmés: director.click, director.type, director.note…
	await expect(page.locator('body')).toBeVisible()
	await director.pause(1500)
})
`
	)
	report.done.push(`${relativeTo(root, demos)}/example.demo.ts créé`)
}

async function ignoreWorkDir(root: string, workDir: string, report: Report) {
	const file = join(root, '.gitignore')
	const entry = `/${relativeTo(root, workDir)}`
	const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
	if (current.split('\n').some((l) => l.trim() === entry)) return report.kept.push(`${entry} déjà ignoré`)
	await writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`)
	report.done.push(`${entry} ajouté au .gitignore`)
}

async function addScripts(root: string, report: Report) {
	const file = join(root, 'package.json')
	if (!existsSync(file)) return report.warnings.push('pas de package.json: scripts non ajoutés')
	const source = readFileSync(file, 'utf8')
	const pkg = JSON.parse(source)
	pkg.scripts ??= {}
	const wanted: Record<string, string> = { demo: 'cademo make', 'demo:edit': 'cademo edit' }
	const added = Object.entries(wanted).filter(([name]) => !pkg.scripts[name])
	if (!added.length) return report.kept.push('scripts demo et demo:edit déjà présents')
	for (const [name, cmd] of added) pkg.scripts[name] = cmd
	const indent = source.match(/^\{\n(\s+)/)?.[1] ?? '\t'
	await writeFile(file, JSON.stringify(pkg, null, indent) + '\n')
	report.done.push(`scripts ajoutés: ${added.map(([n]) => n).join(', ')}`)
}

/** Le dossier du skill dans le projet, et son ancien nom. */
const SKILL_DIR = '.claude/skills/cademo'
const OLD_SKILL_DIR = '.claude/skills/demo-video'

async function installSkill(root: string, report: Report, force: boolean) {
	await removeOldSkill(root, report)
	const target = join(root, SKILL_DIR)
	const source = join(packageRoot, 'skills/cademo/SKILL.md')
	const exists = existsSync(join(target, 'SKILL.md'))
	if (exists && !force) {
		const same = readFileSync(join(target, 'SKILL.md'), 'utf8') === readFileSync(source, 'utf8')
		if (same) return report.kept.push('skill cademo à jour')
		return report.warnings.push(
			'skill cademo différent de celui du paquet: ancienne version ou retouche locale, que ' +
				'`cademo init --skill` écrasera (les consignes propres au projet vont dans CLAUDE.md/AGENTS.md)'
		)
	}
	await mkdir(target, { recursive: true })
	await copyFile(source, join(target, 'SKILL.md'))
	report.done.push(`skill cademo ${exists ? 'mis à jour' : 'installé'} dans .claude/skills/`)
}

/** Le skill s'appelait `demo-video`: l'ancienne copie (ou l'ancien lien) ferait doublon. */
async function removeOldSkill(root: string, report: Report) {
	const old = join(root, OLD_SKILL_DIR)
	const isLink = existsSync(old) && lstatSync(old).isSymbolicLink()
	const file = join(old, 'SKILL.md')
	if (!isLink && !(existsSync(file) && readFileSync(file, 'utf8').includes('cademo'))) return
	await rm(old, { recursive: true })
	report.done.push(`ancien skill ${OLD_SKILL_DIR} retiré (renommé cademo)`)
}

/**
 * Le skill est fourni par cademo et remplacé à chaque mise à jour: il n'a pas à suivre le style du
 * projet. Si le projet utilise Prettier, on le lui fait ignorer.
 */
async function prettierIgnoreSkill(root: string, report: Report) {
	const configs = readdirSync(root).filter((f) => /^(\.prettierrc.*|prettier\.config\..+)$/.test(f))
	const pkg = existsSync(join(root, 'package.json'))
		? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
		: {}
	if (!configs.length && !pkg.prettier) return
	const file = join(root, '.prettierignore')
	const entry = `/${SKILL_DIR}`
	const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')
	if (lines.some((l) => l.trim() === entry)) return
	// L'entrée de l'ancien nom est remplacée sur place.
	const old = lines.findIndex((l) => l.trim() === `/${OLD_SKILL_DIR}`)
	if (old >= 0) lines[old] = entry
	else lines.splice(lines.at(-1) === '' ? -1 : lines.length, 0, entry)
	const content = lines.join('\n')
	await writeFile(file, content.endsWith('\n') ? content : content + '\n')
	report.done.push(`${entry} ajouté au .prettierignore`)
}

const relativeTo = (root: string, path: string) => path.slice(root.length + 1)
