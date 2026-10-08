import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isGitHubPages = process.env.VITE_DEPLOY_TARGET === "github-pages";
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/").at(-1) || "Arc-Shot-Evaluator";

export default defineConfig({
  plugins: [react(), {
    name: "hosted-play-finder-only",
    enforce: "pre",
    resolveId(source) {
      if (!isGitHubPages && source.endsWith("/features/playFinder/PlayFinder")) return "\0play-finder-disabled";
    },
    load(id) {
      if (id === "\0play-finder-disabled") return "export function PlayFinder() { return null; }";
    },
  }],
  base: isGitHubPages ? `/${repositoryName}/` : "/",
  worker: { format: "es" },
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
