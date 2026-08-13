// Host page for a single component. One of these runs inside each canvas iframe.
//
// Loaded as devframe.html?mod=/src/components/Search.tsx
//
// Running each component in its own iframe buys three things a shared page can't:
// real per-frame viewport sizing (so media queries actually fire), style and
// global-state isolation, and a crash in one frame that doesn't take the board
// down with it.

import React from 'react'
import ReactDOM from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { modules, moduleName } from './modules'
import { overrides } from './config'

// The app's real stylesheet -- what makes frames look like the live site.
import '../styles/index.css'

const path = new URLSearchParams(location.search).get('mod') ?? ''

// The harness cannot know a component's props, so it types them as an open bag
// rather than `never`. `FC<never>` reads as "accepts no props at all", which
// makes the component unusable as JSX and unspreadable — the props passed in
// config.tsx would have nowhere to go.
type AnyComponent = React.ComponentType<Record<string, unknown>>

/** Prefer the export named after the file, then default, then any function export. */
function pickExport(mod: Record<string, unknown>, modPath: string) {
    const base = moduleName(modPath)
    if (typeof mod[base] === 'function') return { name: base, Comp: mod[base] as AnyComponent }
    if (typeof mod.default === 'function') return { name: 'default', Comp: mod.default as AnyComponent }
    const found = Object.entries(mod).find(([, v]) => typeof v === 'function')
    if (found) return { name: found[0], Comp: found[1] as AnyComponent }
    return null
}

class Boundary extends React.Component<
    { children: React.ReactNode },
    { error: Error | null }
> {
    state = { error: null as Error | null }
    static getDerivedStateFromError(error: Error) {
        return { error }
    }
    render() {
        if (this.state.error) {
            return (
                <Problem
                    title="Component threw while rendering"
                    detail={this.state.error.message}
                    hint="Give it props in src/devcanvas/config.tsx, or skip it."
                />
            )
        }
        return this.props.children
    }
}

function Problem({ title, detail, hint }: { title: string; detail: string; hint?: string }) {
    return (
        <div
            style={{
                font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
                padding: 20,
                margin: 16,
                borderRadius: 8,
                background: '#2b1416',
                color: '#ffb4b4',
                border: '1px solid #5c2327',
            }}
        >
            <div style={{ fontWeight: 700, marginBottom: 8, color: '#ff8f8f' }}>{title}</div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{detail}</div>
            {hint && <div style={{ marginTop: 10, opacity: 0.7 }}>{hint}</div>}
        </div>
    )
}

function Loading() {
    return (
        <div style={{ font: '13px system-ui', padding: 20, opacity: 0.5 }}>Loading {path}…</div>
    )
}

async function mount() {
    const root = ReactDOM.createRoot(document.getElementById('frame-root')!)

    const loader = modules[path]
    if (!loader) {
        root.render(
            <Problem
                title="Module not in the canvas glob"
                detail={path || '(no ?mod= given)'}
                hint="Check the glob in src/devcanvas/modules.ts."
            />
        )
        return
    }

    // Dynamic import can take a moment on a cold frame; show something first.
    root.render(<Loading />)

    let mod: Record<string, unknown>
    try {
        mod = (await loader()) as Record<string, unknown>
    } catch (e) {
        root.render(
            <Problem title="Import failed" detail={(e as Error).message ?? String(e)} />
        )
        return
    }

    const picked = pickExport(mod, path)
    if (!picked) {
        root.render(
            <Problem
                title="No component export found"
                detail={`Exports: ${Object.keys(mod).join(', ') || '(none)'}`}
            />
        )
        return
    }

    const props = (overrides[path]?.props ?? {}) as Record<string, unknown>

    // MemoryRouter so router hooks work without the frame fighting the parent URL.
    root.render(
        <React.StrictMode>
            <MemoryRouter>
                <Boundary>
                    <picked.Comp {...props} />
                </Boundary>
            </MemoryRouter>
        </React.StrictMode>
    )
}

void mount()

// Tell the parent canvas when Vite hot-updates this frame, so it can flash the card.
if (import.meta.hot) {
    import.meta.hot.on('vite:afterUpdate', () => {
        parent.postMessage({ type: 'canvas:updated', mod: path, at: Date.now() }, '*')
    })
    import.meta.hot.on('vite:error', (err: unknown) => {
        parent.postMessage({ type: 'canvas:error', mod: path, error: String(err) }, '*')
    })
}
