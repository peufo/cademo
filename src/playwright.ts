import type { PlaywrightTestConfig } from '@playwright/test'
import { join } from 'node:path'
import { resolveConfig, type CademoConfig } from './config.ts'
import type { FixtureOptions } from './index.ts'

/**
 * La config Playwright des démos, tirée de `cademo.config.ts`. La CLI l'écrit dans un petit
 * fichier du dossier de travail, hors de `node_modules`, pour que Playwright le transpile et que
 * scénarios et helpers du projet partagent sa copie de `@playwright/test`.
 */
export function playwrightConfig(config: CademoConfig, root: string): PlaywrightTestConfig {
	const resolved = resolveConfig(config, root)
	const viewport = config.viewport ?? { width: 1280, height: 800 }
	const locale = config.locale ?? 'en-US'
	const cademo: FixtureOptions = {
		workDir: resolved.workDir,
		render: config.render ?? {},
		idle: config.idle,
	}
	const base: PlaywrightTestConfig = {
		webServer: config.webServer,
		testDir: resolved.demos,
		testMatch: /\.demo\.[jt]s$/,
		outputDir: join(resolved.workDir, 'test-results'),
		timeout: 180_000,
		workers: 1,
		retries: 0,
		reporter: 'list',
		use: {
			baseURL: config.baseURL,
			browserName: 'chromium',
			// Le « headless shell » par défaut rend sans GPU et tombe à ~8 images/s en ×2 sur les
			// pages à flou d'arrière-plan; le nouveau headless de Chromium tient la cadence.
			channel: 'chromium',
			viewport,
			deviceScaleFactor: 2,
			colorScheme: config.colorScheme ?? 'light',
			locale,
			timezoneId: config.timezoneId,
			launchOptions: {
				// Le screencast ignore la densité émulée: on la force au lancement, sans quoi les zooms
				// seraient flous. `--lang` pour les champs de date natifs, que `locale` ne règle pas.
				args: [`--lang=${locale}`, '--force-device-scale-factor=2'],
			},
			// @ts-expect-error: option propre à la fixture `demo`.
			cademo,
		},
	}
	const extra = config.playwright ?? {}
	return { ...base, ...extra, use: { ...base.use, ...extra.use } }
}
