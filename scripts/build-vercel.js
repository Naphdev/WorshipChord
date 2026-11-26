import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const backendUrl = String(process.env.RENDER_BACKEND_URL || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(backendUrl)) {
  throw new Error('Set RENDER_BACKEND_URL to the HTTPS origin of the Render web service.');
}

const config = 'window.WORSHIPCHORD_CONFIG = Object.freeze({ apiBase: ' + JSON.stringify(backendUrl) + ' });\n';
const output = new URL('../dist/', import.meta.url);
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'app.js', 'styles.css', 'service-worker.js', 'manifest.webmanifest', 'icon.svg']) {
  await copyFile(new URL('../' + file, import.meta.url), new URL(file, output));
}
await writeFile(new URL('runtime-config.js', output), config, 'utf8');
console.log('Generated Vercel runtime config for ' + backendUrl);
