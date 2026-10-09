# cademo

Des vidéos de démo d'une app web, écrites comme des scénarios Playwright et montées
automatiquement : une caméra qui découpe en plans et bouge avec la main, un curseur redessiné,
des temps morts réduits, des bulles d'annotation. Quand l'interface change, on relance.

```
scénario (demos/x.demo.ts) ──► enregistrement ──► raw.mp4 + timeline.json ──► rendu ──► x.mp4
                               (Playwright, CDP     (gestes, effets des         (Remotion: caméra,
                                screencast ×2)       clics, titres)              curseur, bulles)
```

Prérequis : [Bun](https://bun.sh) ≥ 1.2 (la CLI tourne sous Bun), ffmpeg, et `@playwright/test`
dans le projet. Remotion est gratuit pour les individus et les structures de 3 personnes au plus.

## Mise en place

```sh
bun add -d cademo
bunx playwright install chromium
bunx cademo init
```

`cademo init` (idempotent, n'écrase rien) :

- vérifie ffmpeg, `@playwright/test` et Chromium ;
- écrit `cademo.config.ts`, en reprenant le serveur d'un `playwright.config.*` existant et en
  devinant le dossier statique (`static/`, `public/`) pour les vidéos ;
- crée `demos/example.demo.ts` s'il n'y a aucune démo ;
- ignore le dossier de travail dans `.gitignore` ;
- ajoute les scripts `demo` (`cademo make`) et `demo:edit` (`cademo edit`) ;
- installe le skill Claude Code `demo-video` dans `.claude/skills/` (`cademo init --skill` pour le
  mettre à jour).

## Ce que le projet contient

```
cademo.config.ts      la config
demos/*.demo.ts       les scénarios
demos/fixtures.ts     (au choix) les données de démo propres au projet
```

```ts
// cademo.config.ts
import { defineConfig } from 'cademo'
import playwright from './playwright.config'

export default defineConfig({
	demos: 'demos',              // les scénarios
	output: 'static/videos',     // <id>.mp4 et son poster <id>.jpg
	workDir: 'demos/.out',       // enregistrements bruts, timelines, planches de revue
	webServer: playwright.webServer,
	baseURL: playwright.use?.baseURL,
	locale: 'fr-CH',
	timezoneId: 'Europe/Zurich',
	render: { displayOrigin: 'https://mon-app.example' },
})
```

```ts
// demos/create-team.demo.ts
import { demo, expect } from 'cademo'

demo('create-team', async ({ page, director }) => {
	await page.goto('/teams') // hors champ: données, connexion, page de départ
	await director.start()

	await director.click(page.getByRole('button', { name: 'Nouveau secteur' }))
	const drawer = page.getByRole('dialog', { name: 'Nouveau secteur' })
	await expect(drawer).toBeVisible()
	await director.type(drawer.getByLabel('Nom du secteur'), 'Bar principal')
	await director.click(drawer.getByRole('button', { name: 'Valider' }))
	await expect(drawer).toBeHidden()
	await director.pause(1500)
})
```

`demo` est le `test` de Playwright avec une fixture `director` ; le titre est l'identifiant de la
vidéo. Gestes : `click`, `type`, `hover`, `press`, `select`, `scrollTo`, `note` (bulle), `focus`
(cadrage imposé), `skip` (passage lent compressé), `goto`, `pause`. Le skill `demo-video` détaille
l'API et les règles d'écriture.

## CLI

```sh
cademo make [id…] [--no-record] [--no-render]   # enregistre puis rend (toutes sans id)
cademo record [id…]                             # enregistre seulement
cademo render <id>                              # rend une démo enregistrée
cademo review <id>                              # planche-contact de 16 vignettes
cademo edit <id>                                # éditeur de caméra (écrit camera.json)
cademo studio <id>                              # Remotion Studio
cademo list                                     # démos et leur état
```

## Comment c'est monté

- **Enregistrement** : le `director` joue les gestes comme une personne (trajectoires de souris,
  frappe irrégulière) et note chacun dans `timeline.json`. La page est filmée par
  `Page.startScreencast` en ×2, avec le nouveau headless de Chromium (le « headless shell » rend
  sans GPU et rame). Après chaque geste, il attend que l'écran ne bouge plus puis laisse un court
  souffle ; l'image figée au-delà est coupée là où rien ne bouge (`freezedetect`), donc sans coupe
  visible. Pour chaque clic, la zone qui change (volet, dialogue) et la fin de son animation sont
  mesurées ; pour chaque geste, le titre de son conteneur est relevé.
- **Caméra** (`src/render/camera.ts`) : une piste de plans — un plan par contexte (zoom ×1,2–1,9),
  changements de plan synchronisés avec la main, jamais pendant une animation de l'interface, titre
  du volet toujours dans le cadre, poussée discrète, aucune coupe.
- **Éditeur** (`cademo edit`) : reprendre la piste à la main ; elle est écrite dans `camera.json`
  et ne vaut que pour cette prise.
- **Rendu** : composition Remotion (CLI Remotion lancée sous Node), H.264, poster = dernière image.

Remotion peut signaler une « Version mismatch » sur zod si le projet utilise une autre version de
zod : sans conséquence, le rendu n'en dépend pas.

## Développement

```sh
bun install
bun run check    # types
bun run build    # dist/
bun run pack     # .pack/cademo.tgz, l'archive telle que npm l'installerait
```

Pour essayer une version locale dans un projet, installer l'archive (pas `file:`, qui copierait
aussi `node_modules` et doublerait Playwright) :

```sh
(cd ../capture && bun run pack) && bun remove cademo && bun add -d ../capture/.pack/cademo.tgz
```
