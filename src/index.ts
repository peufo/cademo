import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { Director } from './record/director.ts'
import type { RenderOptions } from './timeline.ts'

export { expect, Director }
export { defineConfig, type CademoConfig } from './config.ts'
export type * from './timeline.ts'
export type { CameraTrack, Shot, Camera } from './track.ts'

/** Ce que la config transmet à la fixture `director`. */
export type FixtureOptions = { workDir: string; render: Partial<RenderOptions>; idle?: number }

/** L'identifiant d'une démo, tiré de son titre: `demo('create-teams', …)` → `create-teams`. */
export function demoId(title: string) {
	return title
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
}

/**
 * Une démo: un test Playwright avec la fixture `director`, qui joue et filme les gestes.
 * Son titre est l'identifiant de la vidéo.
 *
 * ```ts
 * demo('create-teams', async ({ page, director }) => {
 *   await page.goto('/teams')          // hors champ
 *   await director.start()
 *   await director.click(page.getByRole('button', { name: 'Nouveau' }))
 * })
 * ```
 */
export const demo = test.extend<{ director: Director }, { cademo: FixtureOptions }>({
	cademo: [{ workDir: 'demos/.out', render: {} }, { option: true, scope: 'worker' }],
	director: async ({ page, cademo }, use, testInfo) => {
		const id = demoId(testInfo.title)
		const director = new Director(page, {
			id,
			outDir: join(cademo.workDir, id),
			render: cademo.render,
			idle: cademo.idle,
		})
		await use(director)
		// Même en échec: le film montre où le scénario s'est arrêté.
		await director.stop()
	},
})
