// Build-time feature flags.
//
// Vite inlines `import.meta.env.*` at build time, so a disabled feature is a
// dead branch the bundler can drop — there is no runtime toggle and no way for
// a visitor to flip one from the browser.
//
// Each flag defaults to ENABLED when the variable is unset, so `npm run dev`
// gives you everything without a .env.development file. Production opts out
// explicitly in .env.production. Same shape as USE_API in lib/api.ts.

/**
 * The /feedback page: nav link and route.
 *
 * Off in production until the submission path is finished — today the form
 * builds a `mailto:` against a placeholder address (FEEDBACK_EMAIL in
 * components/Feedback.tsx), so a real submission would go nowhere. The page
 * stays fully reachable in development.
 *
 * To ship it: drop VITE_FEEDBACK_ENABLED from .env.production (or set it to
 * anything other than "false") and set a real address in Feedback.tsx.
 */
export const FEEDBACK_ENABLED: boolean =
    import.meta.env.VITE_FEEDBACK_ENABLED !== "false";
