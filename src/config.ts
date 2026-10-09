import type { PlaywrightTestConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RenderOptions } from './timeline.ts'

/** La config d'un projet, dans `cademo.config.ts` à sa racine. */
export type CademoConfig = {
	/** Dossier des scénarios (`*.demo.ts`). Par défaut `demos`. */
	demos?: string
	/** Dossier des vidéos finales (`<id>.mp4` et son poster `<id>.jpg`). Par défaut `videos`. */
	output?: string
	/** Dossier de travail: enregistrements bruts, timelines, planches de revue. Par défaut `<demos>/.out`. */
	workDir?: string
	/** Adresse de l'app filmée. */
	baseURL?: string
	/** Le serveur à lancer avant d'enregistrer, comme dans une config Playwright. */
	webServer?: PlaywrightTestConfig['webServer']
	/** Taille de la page filmée, en px CSS. Par défaut 1280×800. */
	viewport?: { width: number; height: number }
	locale?: string
	timezoneId?: string
	colorScheme?: 'light' | 'dark'
	/** Image figée gardée entre deux gestes, en secondes (le reste est coupé). Par défaut 0,1. */
	idle?: number
	/** Options du rendu (taille, cadre, zoom maximal, origine affichée…). */
	render?: Partial<RenderOptions>
	/** Réglages Playwright supplémentaires, fusionnés en dernier. */
	playwright?: PlaywrightTestConfig
}

export type ResolvedConfig = {
	root: string
	file: string
	demos: string
	output: string
	workDir: string
	config: CademoConfig
}

export const CONFIG_FILE = 'cademo.config.ts'

/** Rien d'autre qu'un typage: `export default defineConfig({ … })`. */
export function defineConfig(config: CademoConfig): CademoConfig {
	return config
}

/** Les chemins absolus d'une config, relatifs à la racine du projet. */
export function resolveConfig(config: CademoConfig, root: string, file = join(root, CONFIG_FILE)): ResolvedConfig {
	const demos = resolve(root, config.demos ?? 'demos')
	return {
		root,
		file,
		demos,
		output: resolve(root, config.output ?? 'videos'),
		workDir: resolve(root, config.workDir ?? join(config.demos ?? 'demos', '.out')),
		config,
	}
}

/** Charge `cademo.config.ts` depuis la racine du projet (sous Bun, qui lit le TypeScript). */
export async function loadConfig(root = process.cwd()): Promise<ResolvedConfig> {
	const file = join(root, CONFIG_FILE)
	if (!existsSync(file)) {
		throw new Error(`Pas de ${CONFIG_FILE} dans ${root}: lancer \`bunx cademo init\` d'abord.`)
	}
	const mod = await import(file)
	return resolveConfig(mod.default ?? {}, root, file)
}
