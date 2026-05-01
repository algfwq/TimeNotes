import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import wails from "@wailsio/runtime/plugins/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), wails("./bindings")],
  server: {
    host: "127.0.0.1",
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          canvas: ["konva", "react-konva", "react-moveable"],
          editor: ["@tiptap/react", "@tiptap/starter-kit"],
          collaboration: ["yjs", "@hocuspocus/provider"],
        },
      },
    },
    chunkSizeWarningLimit: 650,
  },
});
