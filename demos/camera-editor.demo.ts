import { demo, expect } from 'cademo'
import type { CameraTrack } from 'cademo'

demo('camera-editor', async ({ page, director }) => {
	// Chaque prise repart de la caméra automatique.
	await page.request.delete('/api/track')
	await page.goto('/')
	await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2)
	const { auto }: { auto: CameraTrack } = await page.request.get('/api/state').then((r) => r.json())
	const vp = { width: 1280, height: 800 }
	await director.start()

	// La lecture anime les deux vues: les garder entières.
	await director.focus(null)
	const play = page.getByTitle('Lecture / pause (espace)')
	await director.click(play)
	await director.pause(1500)
	await director.click(play)

	await director.focus('auto')
	// Le deuxième plan, un ×1,9 sur le volet: son cadre apparaît en bleu sur la source.
	const shot = auto.shots[1]
	await director.click(page.locator('#shots .shot').nth(1))
	await expect(page.locator('#shots .shot.selected')).toBeVisible()

	const source = page.locator('#source')
	const box = (await source.boundingBox())!
	const s = box.width / vp.width
	const w = vp.width / shot.zoom
	const h = vp.height / shot.zoom
	const x = Math.min(Math.max(shot.x - w / 2, 0), vp.width - w)
	const y = Math.min(Math.max(shot.y - h / 2, 0), vp.height - h)
	const at = (px: number, py: number) => ({ x: box.x + px * s, y: box.y + py * s })

	// La source et l'aperçu côte à côte: on voit l'aperçu suivre le cadre.
	await director.focus(null)
	await director.note(source, 'Glisser le cadre pour recadrer', { placement: 'bottom' })
	// Vers la gauche, pour montrer la liste avec le volet.
	const dx = -200
	const dy = 40
	await director.drag(at(x + w / 2, y + h / 2), at(x + w / 2 + dx, y + h / 2 + dy))
	// Tirer un coin élargit le plan.
	const left = x + dx
	const bottom = y + h + dy
	await director.drag(at(left, bottom), at(left - 80, bottom + 45))

	await director.focus('auto')
	await director.click(page.getByRole('button', { name: 'Enregistrer' }))
	await expect(page.getByText('enregistré dans camera.json')).toBeVisible()
	await director.pause(1500)
})
