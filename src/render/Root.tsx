import { Composition, staticFile, type CalculateMetadataFunction } from 'remotion'
import type { Timeline } from '../timeline.ts'
import { Demo, resolveOptions, type DemoProps } from './Demo.tsx'

/**
 * Le dossier public est celui d'un enregistrement: `raw.mp4` et `timeline.json`. La piste éditée à
 * la main, s'il y en a une valable pour cette prise, arrive par les props (`track`): la CLI l'a
 * déjà vérifiée.
 */
const calculateMetadata: CalculateMetadataFunction<DemoProps> = async ({ props }) => {
	const timeline: Timeline = await fetch(staticFile('timeline.json')).then((r) => r.json())
	const { width, height, fps } = resolveOptions(timeline)
	return {
		props: { timeline, track: props.track ?? null },
		width,
		height,
		fps,
		durationInFrames: Math.max(1, Math.floor(timeline.duration * fps)),
	}
}

export function Root() {
	return (
		<Composition
			id="Demo"
			component={Demo}
			calculateMetadata={calculateMetadata}
			defaultProps={{ timeline: undefined as unknown as Timeline, track: null }}
			width={1600}
			height={1000}
			fps={60}
			durationInFrames={60}
		/>
	)
}
