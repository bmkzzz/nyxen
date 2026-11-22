import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

function buildStandaloneNyxenHtml(rootDir: string): string {
  const publicDir = path.join(rootDir, 'public');
  let html = fs.readFileSync(path.join(publicDir, 'Nyxen_EPUB_Reader.html'), 'utf8');

  html = html.replace(/<html\b([^>]*)>/i, (_m, attrs) => {
    const cleanAttrs = /\bdata-nyxen-standalone=/.test(attrs)
      ? attrs
      : `${attrs} data-nyxen-standalone="1"`;
    return `<html${cleanAttrs}>`;
  });

  // Quitar links absolutos al host (/manifest, /icon.svg, etc.) en la copia portable
  html = html.replace(/^[ \t]*<link\b[^>]*\bhref="\/[^"]*"[^>]*>\r?\n?/gim, '');

  // Incrustar los 4 módulos JS
  const modules = ['storage', 'sanitizer', 'epub-zip', 'epub-parser'];
  for (const modName of modules) {
    const modCode = fs.readFileSync(path.join(publicDir, 'modules', `${modName}.js`), 'utf8');
    const scriptRe = new RegExp(
      `<script\\b[^>]*\\bsrc=["']\\.?\\/modules\\/${modName}\\.js["'][^>]*data-nyxen-module=["']${modName}["'][^>]*><\\/script>`,
      'i'
    );
    html = html.replace(scriptRe, () => `<script data-nyxen-module="${modName}">\n${modCode}\n</script>`);
  }

  // Incrustar las 4 portadas por defecto en Base64 para uso offline (file://)
  const coverMap: Record<string, string> = {};
  for (let i = 1; i <= 4; i++) {
    const coverFile = path.join(publicDir, 'covers', `default-${i}.png`);
    if (fs.existsSync(coverFile)) {
      const b64 = fs.readFileSync(coverFile).toString('base64');
      coverMap[`/covers/default-${i}.png`] = `data:image/png;base64,${b64}`;
    }
  }
  if (Object.keys(coverMap).length > 0 && !html.includes('id="nyxenBundledDefaultCovers"')) {
    const coverScript = `<script id="nyxenBundledDefaultCovers">\nwindow.NYXEN_BUNDLED_DEFAULT_COVERS = ${JSON.stringify(coverMap)};\n</script>\n`;
    html = html.replace('<script data-nyxen-module="storage">', () => `${coverScript}<script data-nyxen-module="storage">`);
  }

  // En el archivo standalone descargado, evitar enlace HTTP relativo
  html = html.replace(
    /(<a\b[^>]*id="btnDownloadStandaloneApp"[^>]*\bhref=)["'][^"']*["']/i,
    '$1"#"'
  );

  return html;
}

function nyxenStandaloneDownloadPlugin(): Plugin {
  let rootDir = process.cwd();
  const serveStandalone = (req: {url?: string}, res: any, next: () => void) => {
    const reqPath = (req.url || '').split('?')[0];
    if (reqPath !== '/__download/Nyxen_EPUB_Reader.html') {
      next();
      return;
    }
    try {
      const html = buildStandaloneNyxenHtml(rootDir);
      const buf = Buffer.from(html, 'utf8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Nyxen_EPUB_Reader.html"');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', String(buf.byteLength));
      res.end(buf);
    } catch (err) {
      console.error('Error building standalone HTML:', err);
      res.statusCode = 500;
      res.end('Error generating standalone HTML');
    }
  };

  return {
    name: 'nyxen-standalone-download',
    configResolved(config) {
      rootDir = config.root;
    },
    configureServer(server) {
      server.middlewares.use(serveStandalone);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveStandalone);
    },
    generateBundle() {
      const html = buildStandaloneNyxenHtml(rootDir);
      this.emitFile({
        type: 'asset',
        fileName: '__download/Nyxen_EPUB_Reader.html',
        source: html,
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      nyxenStandaloneDownloadPlugin(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: [],
        manifest: {
          id: '/',
          name: 'Nyxen - EPUB Reader',
          short_name: 'Nyxen',
          description:
            'Lector de libros EPUB local con biblioteca personalizable, anotaciones y temas de lectura.',
          theme_color: '#121212',
          background_color: '#121212',
          display: 'standalone',
          display_override: ['standalone', 'minimal-ui'],
          orientation: 'any',
          start_url: '/',
          scope: '/',
          lang: 'es',
          dir: 'ltr',
          prefer_related_applications: false,
          categories: ['books', 'education', 'utilities'],
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,webmanifest}'],
          globIgnores: ['assets/aistudio/**', '__download/**'],
          ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^v$/],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/Nyxen_EPUB_Reader\.html/, /^\/__download\//],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/api\.dictionaryapi\.dev\/.*/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'dictionary-api-cache',
                expiration: {
                  maxEntries: 150,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
