/** Vite's `?raw` suffix imports a file's text verbatim, bundled into the build. */
declare module "*?raw" {
  const content: string;
  export default content;
}
