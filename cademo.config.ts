import { fileURLToPath } from 'node:url'
import { defineConfig } from './src/config.ts'

const server = fileURLToPath(new URL('demos/editor-server.ts', import.meta.url))

/** Les vidéos de démo de cademo lui-même: l'éditeur de caméra, filmé sur une vraie prise. */
export default defineConfig({
	demos: 'demos',
	output: 'demos/.out/videos',
	workDir: 'demos/.out',
	webServer: { command: `bun ${server}`, url: 'http://localhost:4310/', reuseExistingServer: true },
	baseURL: 'http://localhost:4310',
	locale: 'fr-CH',
	timezoneId: 'Europe/Zurich',
	render: { displayOrigin: 'http://localhost:4300' },
})
