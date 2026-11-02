import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, readdirSync } from 'node:fs'

const googleApiGuideDirectory = new URL('./docs/googleAIstudioAPI/', import.meta.url)

export default defineConfig({
  plugins: [react(), {
    name: 'google-api-key-guide',
    generateBundle() {
      // Keep the guide and its screenshots at the same paths on GitHub Pages.
      for (const name of readdirSync(googleApiGuideDirectory)) {
        this.emitFile({
          type: 'asset',
          fileName: `docs/googleAIstudioAPI/${name}`,
          source: readFileSync(new URL(name, googleApiGuideDirectory)),
        })
      }
    },
  }],
  base: './',
  build: {
    target: 'es2022',
  },
})
