import { cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startEditor } from '../src/editor/server.ts'

/**
 * Le serveur des démos: l'éditeur de caméra ouvert sur une vraie prise, copiée à neuf à chaque
 * lancement (la démo y enregistre un `camera.json`). Par défaut la prise `create-teams` de benev,
 * à côté de ce dépôt; `CADEMO_DEMO_TAKE` pour en désigner une autre.
 */
const take = resolve(process.env.CADEMO_DEMO_TAKE ?? join(import.meta.dir, '../../benev/demos/.out/create-teams'))
if (!existsSync(join(take, 'timeline.json'))) throw new Error(`Pas de prise dans ${take}`)

const dir = join(import.meta.dir, '.out/take')
await rm(dir, { recursive: true, force: true })
await cp(take, dir, { recursive: true, filter: (f) => !f.endsWith('camera.json') })

process.env.CADEMO_NO_OPEN = '1'
await startEditor(dir, { port: Number(process.env.PORT ?? 4310) })
