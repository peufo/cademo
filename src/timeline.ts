/**
 * Ce que l'enregistrement écrit à côté de la vidéo brute, et que le rendu relit. Les temps sont en
 * secondes depuis le début de `raw.mp4` (les passages `skip` en sont déjà retirés), les positions en
 * pixels CSS du viewport.
 */

export type Box = { x: number; y: number; width: number; height: number }

export type CursorKind = 'arrow' | 'pointer' | 'text'

export type TimelineEvent =
	/** Le curseur part de sa position précédente à `t` et arrive en (x, y) à `end`. */
	| { type: 'move'; t: number; end: number; x: number; y: number; cursor: CursorKind }
	| {
			type: 'click'
			t: number
			x: number
			y: number
			box: Box | null
			closeUp?: boolean
			/** Le titre du volet, dialogue ou section qui contient la cible: le contexte à garder. */
			context?: Box
			/** La zone que le clic a fait changer (volet, dialogue, page), si elle est notable. */
			effect?: Box
			/** Fin de l'animation déclenchée par le clic, quand l'image redevient stable. */
			settled?: number
	  }
	/** Une saisie clavier dans `box`, de `t` à `end`. */
	| { type: 'type'; t: number; end: number; box: Box | null; context?: Box }
	/** Un cadrage imposé: une boîte, `null` pour la vue entière, `'auto'` pour rendre la main. */
	| { type: 'focus'; t: number; box: Box | null | 'auto'; scale?: number }
	| {
			type: 'note'
			t: number
			end: number
			box: Box
			text: string
			placement?: 'top' | 'bottom' | 'left' | 'right'
			context?: Box
	  }
	| { type: 'url'; t: number; url: string }

export type RenderOptions = {
	width: number
	height: number
	fps: number
	/**
	 * `none`: l'interface remplit l'image. `window`: une fenêtre de navigateur aux coins arrondis
	 * sur `background`.
	 */
	frame: 'none' | 'window'
	/** Zoom des plans moyens (moins si la zone à montrer n'y tient pas). */
	maxZoom: number
	/** Zoom des gros plans demandés par le scénario (`click(…, { closeUp: true })`). */
	closeUpZoom: number
	/** Barre de navigateur au-dessus de la page (cadre `window` seulement). */
	browserChrome: boolean
	background: string
	/** Remplace l'origine dans la barre d'adresse (`http://localhost:4173` → `https://benev.io`). */
	displayOrigin?: string
	/** Ondes au clic, en plus de l'appui du curseur. */
	ripple: boolean
}

export const defaultRenderOptions: RenderOptions = {
	width: 1280,
	height: 800,
	fps: 60,
	frame: 'none',
	maxZoom: 1.9,
	closeUpZoom: 2.6,
	browserChrome: true,
	background: 'linear-gradient(135deg, #2663eb 0%, #6d4fe0 55%, #e69214 130%)',
	ripple: true,
}

export type Timeline = {
	id: string
	title?: string
	viewport: { width: number; height: number }
	/** Durée de `raw.mp4`. */
	duration: number
	/** Position du curseur au début de la vidéo. */
	cursorStart: { x: number; y: number }
	events: TimelineEvent[]
	render: Partial<RenderOptions>
}
