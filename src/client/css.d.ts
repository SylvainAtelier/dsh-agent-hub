/** Stylesheets bundled as text (esbuild `.css` text loader), injected at runtime. */
declare module '*.css' {
  const text: string
  export default text
}

/** Font files bundled as base64 (esbuild `.woff2` base64 loader, the font chunk only). */
declare module '*.woff2' {
  const data: string
  export default data
}
