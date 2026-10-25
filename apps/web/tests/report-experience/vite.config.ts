import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here("."),
  plugins: [
    {
      name: "report-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          (importer?.endsWith("/HtmlRenderFrame.tsx") &&
            (source.endsWith("/assets/assetUrls") || source.endsWith("/state/filesystem"))) ||
          ((importer?.endsWith("/ViewerLinkedPane.tsx") ||
            importer?.endsWith("/ViewerOverlayHost.tsx")) &&
            source.endsWith("/files/projectFilesQueryState")) ||
          // The Files fixture: the artifact viewer and a missing file's folder listing.
          (importer?.endsWith("/ThreadArtifacts.tsx") &&
            (source.endsWith("/assets/assetUrls") ||
              source.endsWith("/files/projectFilesQueryState"))) ||
          (importer?.endsWith("/MissingFileNotice.tsx") && source === "./useExistingFileLinks") ||
          (importer?.endsWith("/useHtmlRenderTheme.ts") &&
            (source === "./useTheme" || source === "./useSettings"))
        )
          return here("./stubs.ts");
      },
      configureServer(server) {
        server.middlewares.use("/report.html", async (req, res) => {
          const mod = await server.ssrLoadModule(
            here("../../../../packages/shared/src/htmlRender.ts"),
          );
          let html = readFileSync(
            here(
              req.url?.includes("historical")
                ? "../../../../.artifacts/report-experience/ps23.html"
                : req.url?.includes("evidence")
                  ? "./evidence.html"
                  : "../../../../docs/reports/report-example.html",
            ),
            "utf8",
          );
          if (req.url?.includes("historical")) {
            res.setHeader("Content-Type", "text/html");
            res.end(html);
            return;
          }
          if (req.url?.includes("long"))
            html = html.replace(
              "</article>",
              "<section><h2>Long report fixture</h2>" +
                "<p>Additional evidence paragraph for reading-position verification.</p>".repeat(
                  100,
                ) +
                "</section></article>",
            );
          res.setHeader("Content-Type", "text/html");
          if (req.url?.includes("hidden-menu"))
            html = html.replace(
              "</article>",
              '<div role="menu" hidden>Retained menu</div></article>',
            );
          html = html.replace(
            "</body>",
            `<script>const loadId=Date.now()+Math.random();function report(){parent.postMessage({fixtureReport:{loadId,background:getComputedStyle(document.documentElement).getPropertyValue('--background'),accent:getComputedStyle(document.documentElement).getPropertyValue('--accent'),accentForeground:getComputedStyle(document.documentElement).getPropertyValue('--accent-foreground'),selected:document.querySelector('[role=tab][aria-selected=true]')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth}},'*')}window.addEventListener('load',report);window.addEventListener('message',()=>setTimeout(report,10));document.addEventListener('click',()=>setTimeout(report,10));document.addEventListener('keydown',()=>setTimeout(report,10));if(location.search.includes('owns-escape'))document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();parent.postMessage({fixtureEscapeHandled:true},'*')}});</script></body>`,
          );
          res.end(mod.injectHtmlRenderBootstrap(html));
        });
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "~": here("../../src"),
      "@specweave-studio/shared/htmlRender": here("../../../../packages/shared/src/htmlRender.ts"),
    },
  },
  server: { host: "127.0.0.1", port: 5843, strictPort: true },
  build: {
    outDir: here("../../../../.artifacts/report-experience/site"),
    emptyOutDir: true,
    rollupOptions: { input: { index: here("./index.html"), files: here("./files.html") } },
  },
});
