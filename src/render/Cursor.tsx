import type { CursorKind } from '../timeline.ts'

export { cursorAt, type CursorState } from '../cursor-path.ts'

/** Les trois formes du curseur, dessinées pour une hauteur de 32 et une pointe en (0, 0). */
export function CursorGlyph({ kind, size }: { kind: CursorKind; size: number }) {
	const s = size / 32
	const common = {
		width: 32 * s,
		height: 32 * s,
		viewBox: '0 0 32 32',
		style: { overflow: 'visible', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))' },
	} as const

	if (kind === 'text') {
		// Le I se centre sur le point visé.
		return (
			<svg {...common} style={{ ...common.style, transform: 'translate(-50%, -50%)' }}>
				<path
					d="M11 6h4l1 1 1-1h4M16 7v18M11 26h4l1-1 1 1h4"
					fill="none"
					stroke="white"
					strokeWidth={5}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
				<path
					d="M11 6h4l1 1 1-1h4M16 7v18M11 26h4l1-1 1 1h4"
					fill="none"
					stroke="#111"
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		)
	}
	if (kind === 'pointer') {
		// La main: l'index pointe vers le point visé.
		return (
			<svg {...common} style={{ ...common.style, transform: 'translate(-34%, -4%)' }}>
				<path
					d="M10 3.5c0-1.6 1.2-2.8 2.7-2.8s2.8 1.2 2.8 2.8V13l.3-.1c.4-1.2 1.5-2 2.7-2 1.3 0 2.4.9 2.7 2.1 .5-.7 1.4-1.1 2.3-1.1 1.4 0 2.6 1.1 2.7 2.5 .5-.3 1-.4 1.5-.4 1.6 0 2.8 1.3 2.8 2.8V22c0 5.5-4.2 9.5-9.6 9.5h-2.2c-3.3 0-5.6-1.3-7.4-3.8L4.6 20.9c-.9-1.3-.6-3 .6-3.9 1.2-.9 2.9-.7 3.9.4l.9 1.1V3.5z"
					fill="#fff"
					stroke="#111"
					strokeWidth={1.6}
					strokeLinejoin="round"
				/>
				<path d="M15.5 14v7M20.5 15v6M25 16.5v5" stroke="#111" strokeWidth={1.4} strokeLinecap="round" />
			</svg>
		)
	}
	return (
		<svg {...common}>
			<path
				d="M1 1v24.5l6.2-6 4.1 9.6 4.4-1.9-4-9.3h8.6L1 1z"
				fill="#111"
				stroke="#fff"
				strokeWidth={2}
				strokeLinejoin="round"
			/>
		</svg>
	)
}
