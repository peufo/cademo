import { useMemo } from 'react'
import {
	AbsoluteFill,
	OffthreadVideo,
	interpolate,
	spring,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion'
import { loadFont } from '@remotion/google-fonts/Barlow'
import { defaultRenderOptions, type Box, type RenderOptions, type Timeline } from '../timeline.ts'
import { autoTrack, type Camera } from './camera.ts'
import { evaluateTrack, type CameraTrack } from '../track.ts'
import { createLayout, type Layout } from './layout.ts'
import { CursorGlyph, cursorAt } from './Cursor.tsx'

const { fontFamily } = loadFont('normal', { weights: ['500', '600'], subsets: ['latin'] })

/** `track`: la piste éditée à la main (`camera.json`); sans elle, la caméra automatique. */
export type DemoProps = { timeline: Timeline; track?: CameraTrack | null }

export function resolveOptions(timeline: Timeline): RenderOptions {
	return { ...defaultRenderOptions, ...timeline.render }
}

export function Demo({ timeline, track }: DemoProps) {
	const frame = useCurrentFrame()
	const { fps, durationInFrames } = useVideoConfig()
	const options = resolveOptions(timeline)
	const layout = useMemo(() => createLayout(timeline, options), [timeline])
	const camera = useMemo(
		() => evaluateTrack(track ?? autoTrack(timeline, options), timeline.viewport),
		[timeline, track]
	)
	const t = frame / fps
	const cam = camera.at(t)
	const o = layout.offset(cam)

	return (
		<AbsoluteFill style={{ background: options.background, fontFamily }}>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					transformOrigin: '0 0',
					transform: `translate(${o.x}px, ${o.y}px) scale(${cam.zoom})`,
				}}
			>
				<Window layout={layout} timeline={timeline} t={t} options={options} />
			</div>
			<Notes layout={layout} timeline={timeline} cam={cam} frame={frame} fps={fps} />
			<Cursor layout={layout} timeline={timeline} cam={cam} t={t} ripple={options.ripple} />
		</AbsoluteFill>
	)
}

function Window({
	layout,
	timeline,
	t,
	options,
}: {
	layout: Layout
	timeline: Timeline
	t: number
	options: RenderOptions
}) {
	const { win, content, chrome } = layout
	const radius = layout.framed ? Math.round(layout.H * 0.014) : 0
	return (
		<div
			style={{
				position: 'absolute',
				left: win.x,
				top: win.y,
				width: win.width,
				height: win.height,
				borderRadius: radius,
				overflow: 'hidden',
				background: '#fff',
				boxShadow: layout.framed
					? '0 0 0 1px rgba(0,0,0,.08), 0 30px 60px -12px rgba(15,23,42,.45), 0 18px 36px -18px rgba(15,23,42,.5)'
					: 'none',
			}}
		>
			{chrome > 0 && <ChromeBar height={chrome} url={currentUrl(timeline, t, options)} />}
			<OffthreadVideo
				src={staticFile('raw.mp4')}
				muted
				style={{ position: 'absolute', left: 0, top: chrome, width: content.width, height: content.height }}
			/>
		</div>
	)
}

function currentUrl(timeline: Timeline, t: number, options: RenderOptions) {
	let url = ''
	for (const e of timeline.events) {
		if (e.t > t) break
		if (e.type === 'url') url = e.url
	}
	if (!url) return ''
	const parsed = new URL(url)
	const origin = options.displayOrigin ?? parsed.origin
	// Les paramètres d'état des tiroirs (`?form_team=%7B%7D`) n'apportent rien à l'œil.
	return (origin + parsed.pathname).replace(/^https?:\/\//, '')
}

function ChromeBar({ height, url }: { height: number; url: string }) {
	const dot = height * 0.26
	return (
		<div
			style={{
				height,
				display: 'flex',
				alignItems: 'center',
				gap: dot * 0.7,
				padding: `0 ${height * 0.4}px`,
				background: '#f1f2f4',
				borderBottom: '1px solid #e2e4e8',
			}}
		>
			{['#ff5f57', '#febc2e', '#28c840'].map((c) => (
				<div key={c} style={{ width: dot, height: dot, borderRadius: '50%', background: c }} />
			))}
			<div
				style={{
					flex: 1,
					maxWidth: '55%',
					margin: '0 auto',
					height: height * 0.62,
					borderRadius: height * 0.31,
					background: '#fff',
					border: '1px solid #e2e4e8',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					gap: height * 0.15,
					fontSize: height * 0.32,
					color: '#4b5563',
				}}
			>
				<svg width={height * 0.28} height={height * 0.28} viewBox="0 0 16 16" fill="#9ca3af">
					<path d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z" />
				</svg>
				{url}
			</div>
			<div style={{ width: dot * 3 + dot * 1.4 }} />
		</div>
	)
}

function Cursor({
	layout,
	timeline,
	cam,
	t,
	ripple,
}: {
	layout: Layout
	timeline: Timeline
	cam: Camera
	t: number
	ripple: boolean
}) {
	const state = cursorAt(timeline, t)
	const p = layout.project(cam, state)
	// Le curseur fait partie de l'image: il grossit avec elle, énorme dans les inserts.
	const scale = layout.k * cam.zoom
	const size = 24 * scale
	return (
		<>
			{(ripple ? state.ripples : []).map((r, i) => {
				const c = layout.project(cam, r)
				const k = r.age / 0.6
				const radius = interpolate(k, [0, 1], [6, 34], { extrapolateRight: 'clamp' }) * scale
				return (
					<div
						key={i}
						style={{
							position: 'absolute',
							left: c.x - radius,
							top: c.y - radius,
							width: radius * 2,
							height: radius * 2,
							borderRadius: '50%',
							border: `${3 * scale}px solid rgba(38, 99, 235, ${0.7 * (1 - k)})`,
							background: `rgba(38, 99, 235, ${0.18 * (1 - k)})`,
						}}
					/>
				)
			})}
			<div
				style={{
					position: 'absolute',
					left: p.x,
					top: p.y,
					transformOrigin: '0 0',
					transform: `scale(${state.press})`,
				}}
			>
				<CursorGlyph kind={state.kind} size={size} />
			</div>
		</>
	)
}

/**
 * Une bulle posée sur un formulaire en cache les champs. Quand le conteneur de la cible (volet,
 * dialogue) laisse à l'image la place de la bulle sur un côté, elle s'y range, à la hauteur de la
 * cible, du côté le plus proche d'elle: le halo dit de quoi elle parle.
 */
function outsideContainer(
	layout: Layout,
	cam: Camera,
	e: { box: Box; container?: Box },
	width: number
): { side: 'left' | 'right'; edge: number } | null {
	if (!e.container) return null
	const c = e.container
	const cl = layout.project(cam, c)
	const cr = layout.project(cam, { x: c.x + c.width, y: c.y + c.height })
	const tl = layout.project(cam, e.box)
	const br = layout.project(cam, { x: e.box.x + e.box.width, y: e.box.y + e.box.height })
	const sides = [
		{ side: 'left' as const, edge: cl.x, room: cl.x, distance: tl.x - cl.x },
		{ side: 'right' as const, edge: cr.x, room: layout.W - cr.x, distance: cr.x - br.x },
	]
		.filter((s) => s.room >= width)
		.sort((a, b) => a.distance - b.distance)
	return sides[0] ?? null
}

function Notes({
	layout,
	timeline,
	cam,
	frame,
	fps,
}: {
	layout: Layout
	timeline: Timeline
	cam: Camera
	frame: number
	fps: number
}) {
	const t = frame / fps
	return (
		<>
			{timeline.events.map((e, i) => {
				if (e.type !== 'note' || t < e.t || t > e.end + 0.4) return null
				const enter = spring({ frame: frame - Math.round(e.t * fps), fps, config: { damping: 14 } })
				const exit = interpolate(t, [e.end, e.end + 0.3], [1, 0], {
					extrapolateLeft: 'clamp',
					extrapolateRight: 'clamp',
				})
				const opacity = Math.min(enter, exit)

				const tl = layout.project(cam, e.box)
				const br = layout.project(cam, { x: e.box.x + e.box.width, y: e.box.y + e.box.height })
				// La bulle grandit avec l'image, moins vite qu'elle, pour rester lisible sans l'envahir.
				const font = layout.H * 0.022 * Math.sqrt(cam.zoom)
				const gap = font * 0.9
				// Largeur estimée, pour ne jamais la laisser déborder du cadre.
				const half = (e.text.length * font * 0.55) / 2 + font
				const outside = e.placement ? null : outsideContainer(layout, cam, e, half * 2 + gap * 2)
				const placement = e.placement ?? (tl.y > font * 4 ? 'top' : 'bottom')
				const cx = Math.min(Math.max((tl.x + br.x) / 2, half + gap), layout.W - half - gap)
				const cy = (tl.y + br.y) / 2
				const pos: React.CSSProperties = outside
					? outside.side === 'left'
						? { left: outside.edge - gap, top: cy, transform: 'translate(-100%, -50%)' }
						: { left: outside.edge + gap, top: cy, transform: 'translate(0, -50%)' }
					: placement === 'top'
						? { left: cx, top: tl.y - gap, transform: 'translate(-50%, -100%)' }
						: placement === 'bottom'
							? { left: cx, top: br.y + gap, transform: 'translate(-50%, 0)' }
							: placement === 'left'
								? { left: tl.x - gap, top: (tl.y + br.y) / 2, transform: 'translate(-100%, -50%)' }
								: { left: br.x + gap, top: (tl.y + br.y) / 2, transform: 'translate(0, -50%)' }
				const pad = font * 0.25
				return (
					<div key={i}>
						{/* Halo autour de l'élément annoté */}
						<div
							style={{
								position: 'absolute',
								left: tl.x - pad,
								top: tl.y - pad,
								width: br.x - tl.x + pad * 2,
								height: br.y - tl.y + pad * 2,
								borderRadius: font * 0.5,
								boxShadow: `0 0 0 ${font * 0.14}px rgba(38,99,235,.85), 0 0 ${font}px rgba(38,99,235,.45)`,
								opacity,
							}}
						/>
						<div style={{ position: 'absolute', ...pos }}>
							<div
								style={{
									opacity,
									transform: `scale(${0.85 + 0.15 * enter})`,
									transformOrigin: placement === 'top' ? '50% 100%' : '50% 0',
									padding: `${font * 0.45}px ${font * 0.8}px`,
									borderRadius: font * 0.6,
									background: '#111827',
									color: '#fff',
									fontSize: font,
									fontWeight: 600,
									whiteSpace: 'nowrap',
									boxShadow: '0 10px 30px -8px rgba(0,0,0,.45)',
								}}
							>
								{e.text}
							</div>
						</div>
					</div>
				)
			})}
		</>
	)
}
