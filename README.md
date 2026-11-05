# UrlDocs

Annotate any web page and share your notes in a single link — no backend, no accounts.
Purely static, designed to be hosted on GitHub Pages.

## How it works

1. Paste a URL. The page HTML is fetched through a public CORS proxy and rendered in an
   `<iframe>`.
2. Select text on the loaded page → a **Note** button appears. Pick a color
   (yellow / green / blue), type a note, save.
3. **Share link** copies a URL that encodes all of your annotations (colors, notes,
   and text anchors) compressed with LZ-String in the URL `#hash`.
4. Anyone opening that link gets the same page with the same highlights and notes —
   nothing is stored on any server.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell: URL form, iframe, note card, sidebar |
| `app.js` | All logic: proxy fetching, text anchoring, highlighting, share-link encode/decode |
| `style.css` | Styling (deliberately simple: three pastel highlight colors) |
| `demo.html` | Local sample page for trying the app without a network |
| `lz-string.js` | Vendored LZ-String (WTFPL) so compression works with no CDN dependency |

## Run locally

Any static server works:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(The demo page works even from `file://`, but proxy fetching requires `http://`.)

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo: **Settings → Pages → Source** = *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Your site is live at `https://<user>.github.io/<repo>/`.

### Will it work from GitHub Pages?

Yes. For any remote site the app **first tries to embed the live page directly**
in the `<iframe>` — this renders the full page with JS and CSS, so sites that are
impossible to proxy still at least *display*. But a cross-origin iframe's DOM is
off-limits to the browser (same-origin policy), so on that path annotation isn't
possible. The app then **fetches the HTML through a public CORS proxy** and loads
*that* into the frame, where highlighting works. Order per remote URL:

1. Direct embed → if the site allows it and its DOM is reachable, annotate in place.
2. Proxy fetch (4 proxies tried in order) → annotate the fetched copy (static HTML).
3. Both fail → the live page stays visible **read-only**, with a clear message.

Your hosting origin (your `github.io` subdomain) is irrelevant to any of this —
the browser only talks directly to the proxy. So the CORS errors you may see
locally are the same ones you'd see on GitHub Pages: they come from a proxy being
blocked or rate-limited, not from your hosting.

Caveats that remain regardless of hosting:

- Public proxies can be slow, rate-limited, or blocked by the target site.
- JavaScript-only sites (SPAs) render as an empty shell in the *proxy* path,
  because proxied HTML has no scripts — but the *direct* path can show them live
  (read-only).
- If you want a guaranteed *annotatable* experience for one specific site, the
  robust fix is a tiny serverless fetch function (e.g. a Cloudflare Worker) that
  proxies requests with your own CORS headers — swap it into the `PROXIES` list
  in `app.js`.

## Notes & limitations

- **CORS proxies**: remote pages load via `allorigins.win` → `corsproxy.io` →
  `codetabs` (first that succeeds). Sites that block proxy traffic, or that are
  JavaScript-only SPAs, will not render fully (scripts are stripped from proxied HTML,
  so only static content is annotated). Pages over 5 MB are refused.
  Pages on the *same origin* as the app load directly into the iframe (fully working).
- **Anchors are structural**: highlights point to a position in the page's HTML
  (element path + character offsets in its text). If the original site changes its
  HTML, affected highlights simply stop appearing; the rest survive.
- **Hash-only storage**: annotation data lives entirely in the URL fragment. Long
  documents with many notes produce long URLs — fine for personal sharing.
- **No auth, no persistence**: by design. Clearing the notes or loading a new page
  discards them.
