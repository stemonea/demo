import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { themeAssets } from './scripts/theme-assets.ts'

// https://vite.dev/config/
export default defineConfig({
  base: './', // relative asset paths: deployable to any static host / subfolder
  plugins: [themeAssets(), react()],
})
