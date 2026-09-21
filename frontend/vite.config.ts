import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isGitHubPages = process.env.VITE_DEPLOY_TARGET === "github-pages";
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/").at(-1) || "Arc-Shot-Evaluator";

export default defineConfig({
  plugins: [react()],
  base: isGitHubPages ? `/${repositoryName}/` : "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7888",
      "/media": "http://127.0.0.1:7888",
    },
  },
});
