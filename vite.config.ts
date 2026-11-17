import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'path';
import { glob } from "glob";
import { defineConfig, loadEnv, ConfigEnv } from 'vite';
import { do_render } from './src/template/render'
import { ProxyAgent, setGlobalDispatcher } from "undici";

const proxy = process.env.https_proxy
  || process.env.HTTPS_PROXY;

if (proxy) {
  console.log("Using proxy:", proxy);

  setGlobalDispatcher(
    new ProxyAgent(proxy)
  );
}

const OUT_DIR = 'dist'

const find_index_html = () => glob.sync(resolve(__dirname, "**", "index.html")).filter(
  p=>!p.includes('/public/') && !p.includes(`/${OUT_DIR}/`) && !p.includes('/node_modules/')
)


// https://vitejs.dev/config/
export default async ({mode, isPreview}: ConfigEnv) => {
  const env = loadEnv(mode, process.cwd());
  // Las plantillas se renderizan ANTES de buscar los index.html de entrada,
  // así un único `vite build` incluye todas las páginas de los concursos.
  // (vite 5.0 no informa isPreview en `vite preview`, de ahí la comprobación de argv)
  const preview = isPreview || process.argv.includes('preview');
  if (!preview) await do_render(env);
  return defineConfig({
    base: "./",
    build: {
      rollupOptions: {
        input: find_index_html(),
      },
      outDir: OUT_DIR
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    }
  })
}
