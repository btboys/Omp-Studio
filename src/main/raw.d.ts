// Allow importing file contents as strings via Vite's `?raw` suffix.
declare module "*?raw" {
  const src: string;
  export default src;
}
