import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, "");
  const apiPort = Number(env.API_PORT || 8787);
  const webPort = Number(env.WEB_PORT || 5173);

  return {
    envDir: workspaceRoot,
    plugins: [
      react(),
      VitePWA({
        registerType: "prompt",
        includeAssets: ["meet.svg"],
        manifest: {
          name: "Meet · AI 角色实时聊天",
          short_name: "Meet",
          description: "私有部署的 AI 实时语音角色聊天应用",
          theme_color: "#17130f",
          background_color: "#f4efe6",
          display: "standalone",
          start_url: "/",
          icons: [
            {
              src: "/meet.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any maskable",
            },
          ],
        },
        workbox: {
          cleanupOutdatedCaches: true,
          navigateFallbackDenylist: [/^\/api\//],
        },
      }),
    ],
    server: {
      host: "0.0.0.0",
      port: webPort,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
