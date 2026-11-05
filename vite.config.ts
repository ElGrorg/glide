import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build so the game can be shared as one HTML page.
export default defineConfig({ base: './', plugins: [viteSingleFile()] });
