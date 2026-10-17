import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            // Split rarely-changing dependencies from app code so a deploy only
            // invalidates the small app chunk in browser caches.
            codeSplitting: {
              groups: [
                { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 3 },
                { name: "clerk", test: /node_modules[\\/]@clerk[\\/]/, priority: 2 },
                { name: "motion", test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/, priority: 2 },
              ],
            },
          },
        },
      },
    },
  },
});
