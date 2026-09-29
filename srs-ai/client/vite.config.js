import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
 server: {
allowedHosts: ['merchandise-stronger-also-beta.trycloudflare.com'],proxy: {
    '/api': 'http://localhost:5000',
  },
},
})
