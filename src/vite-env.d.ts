// Vite asset URL import declarations.
//
// The project tsconfig includes neither `vite/client` nor the worker types, so
// these ambient declarations give `import x from '...?worker&url'` its URL
// string type. `?worker&url` builds the referenced module as a standalone JS
// chunk and returns the emitted asset URL (used for the AudioWorklet module,
// which `audioWorklet.addModule()` fetches as a classic module).

declare module '*?url' {
  const src: string
  export default src
}

declare module '*?worker&url' {
  const src: string
  export default src
}
