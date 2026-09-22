import { defineConfig } from "vite";

// GitHub Pages serves the app from a repository subpath, so the asset base has
// to be injected at build time. Local builds and previews keep the root base.
export default defineConfig({
  base: process.env.KINJO_BASE ?? "/",
});
