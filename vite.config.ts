// 配置本地开发与后续静态部署所需的 Vite 构建行为。
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
});
