// The one place the watched directory is declared.
//
// Vite requires a literal string here, so change THIS GLOB to point the canvas
// somewhere else (e.g. '/src/pages/*.tsx'). Because import.meta.glob is
// HMR-aware, adding or deleting a matching file updates the canvas immediately
// -- no polling, no restart.
export const modules = import.meta.glob('/src/components/*.tsx')

export const GLOB_LABEL = 'src/components/*.tsx'

/** '/src/components/Search.tsx' -> 'Search' */
export function moduleName(path: string): string {
    return path.split('/').pop()!.replace(/\.tsx?$/, '')
}
