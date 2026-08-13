// Per-component overrides for the dev canvas.
//
// Most components here take no props and render fine on their own. The ones that
// need props (or a specific viewport) get an entry below. Everything not listed
// renders with no props at the default size.

export interface FrameConfig {
    /** Props handed to the component. */
    props?: Record<string, unknown>
    /** Viewport width/height of this frame's iframe, in CSS px. */
    width?: number
    height?: number
    /** Hide from the canvas entirely. */
    skip?: boolean
    /** Note shown in the frame header. */
    note?: string
}

export const DEFAULT_WIDTH = 1280
export const DEFAULT_HEIGHT = 820

export const overrides: Record<string, FrameConfig> = {
    // Needs a case to display and a close handler.
    '/src/components/CaseDetail.tsx': {
        props: { caseId: '1', onClose: () => console.log('[canvas] onClose'), view: 'case' },
        note: 'caseId="1" (edit in devcanvas/config.tsx)',
    },

    // A layout wrapper -- give it something to wrap so it isn't an empty box.
    '/src/components/Background.tsx': {
        props: {
            children: (
                <div style={{ padding: 48, color: '#fff', font: '600 20px system-ui' }}>
                    Background wrapper — children placeholder
                </div>
            ),
        },
        height: 600,
    },

    // Chrome that's more useful short than tall.
    '/src/components/Navbar.tsx': { height: 220 },
    '/src/components/Footer.tsx': { height: 420 },
}
