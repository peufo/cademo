#!/usr/bin/env bun
import { loadConfig } from './config.ts'
import { edit, list, make, record, renderDemo, review, studio } from './commands.ts'
import { init } from './init.ts'

const usage = `cademo — vidéos de démo d'une app web, écrites comme des scénarios Playwright

  cademo init [--skill]                    met le projet en place (--skill: met à jour le skill seul)
  cademo make [id…] [--no-record] [--no-render]
                                           enregistre puis rend (toutes les démos sans id)
  cademo record [id…]                      enregistre seulement
  cademo render <id>                       rend une démo enregistrée
  cademo review <id>                       planche-contact de la vidéo rendue
  cademo edit <id>                         éditeur de caméra
  cademo studio <id>                       Remotion Studio
  cademo list                              démos et leur état

Config: cademo.config.ts à la racine du projet.`

const [command, ...rest] = process.argv.slice(2)
const ids = rest.filter((a) => !a.startsWith('--'))
const has = (flag: string) => rest.includes(`--${flag}`)
const one = () => {
	if (!ids[0]) throw new Error(`Préciser la démo: cademo ${command} <id>`)
	return ids[0]
}

try {
	const root = process.cwd()
	if (command === 'init') await init(root, { skill: has('skill') })
	else if (!command || command === 'help' || has('help')) console.log(usage)
	else {
		const config = await loadConfig(root)
		if (command === 'make') await make(config, ids, { record: !has('no-record'), render: !has('no-render') })
		else if (command === 'record') await record(config, ids)
		else if (command === 'render') await renderDemo(config, one())
		else if (command === 'review') await review(config, one())
		else if (command === 'edit') await edit(config, one())
		else if (command === 'studio') await studio(config, one())
		else if (command === 'list') list(config)
		else {
			console.error(`Commande inconnue: ${command}\n\n${usage}`)
			process.exit(1)
		}
	}
} catch (e) {
	console.error((e as Error).message)
	process.exit(1)
}
