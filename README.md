# Dadventures

A small local web app for making illustrated story books, flash cards and print-ready sheets. It generates 2K/4K
images with OpenAI's GPT Image 2.6 models (`gpt-image-2.6-flare` and `gpt-image-2.6-sunburst`; the 2.5 pair stays
selectable), keeps every prompt with its image, and has zero npm dependencies.

## Requirements

- **Node.js 22 or newer.** There is nothing to `npm install`.
- **An OpenAI API key** with access to the image models. Every generation, enhancement and book or card step is billed
  to your account; the Costs page tracks the spend.
- **macOS is the tested platform.** Thumbnails, image downscaling and the Print Sheets PDF detail cap use `sips`, and
  "Reveal in Finder" uses `open`. On Linux, Windows or in Docker the app still runs, with full-size images in place of
  thumbnails.
- Optional: a [Real-ESRGAN ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN/releases) binary for free local upscaling
  (`REALESRGAN_BIN`), or a [fal.ai](https://fal.ai) key for cloud upscaling (`FAL_KEY`).

## Run

```bash
cp .env.example .env     # add your OPENAI_API_KEY
npm start                # → http://127.0.0.1:53405
```

Or with Docker:

```bash
docker compose up --build   # → http://127.0.0.1:53405
```

## What it does

| Page | Address | What it is for | Guide |
|---|---|---|---|
| Images | `/` | Generate 2K/4K images, enhance prompts, keep every prompt and setting with its image | [Generating and history](docs/generating-and-history.md) |
| Characters | `/characters.html` | Reusable characters with reference images, so a cast stays on-model | [Character consistency](docs/characters.md) |
| Story Books | `/books.html` | Outline, write and illustrate short children's books | [Story Books](docs/story-books.md) |
| Flash Cards | `/cards.html` | Turn existing cards into templates, then make sets and story series | [Flash Cards](docs/flash-cards.md) |
| Print Sheets | `/sheets.html` | Tile images N-up into print-ready, optionally double-sided PDFs | [Print Sheets](docs/print-sheets.md) |
| Costs | `/costs.html` | Spend per day, model, activity and project, from a ledger of every model call | [AI calls and costs](docs/costs.md) |

Also: [upscaling](docs/upscaling.md) with local Real-ESRGAN or fal.ai, and a [shareable URL](docs/links.md) for every view.

## Repository layout

| Path | What |
|---|---|
| [`src/`](src/README.md) | the Node server: HTTP routes, the AI gateway, books, cards and print sheets |
| [`public/`](public/README.md) | the browser UI: plain HTML, CSS and JavaScript, no build step |
| [`docs/`](docs/README.md) | feature guides |
| [`media/`](media/README.md) | your own images for Print Sheets and Flash Cards (contents ignored by git) |
| `output/` | created on first run: your images, prompts, logs and call records (ignored by git) |
| `.env.example` | copy to `.env` and add your key |
| `Dockerfile`, `docker-compose.yml` | optional container setup |

## Config (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | — | required |
| `PORT` | `53405` | |
| `HOST` | `127.0.0.1` | set `0.0.0.0` to expose on LAN (see [Security](#security)) |
| `ALLOWED_HOSTS` | — | extra hostnames allowed to reach the app, comma separated (e.g. `studio.local`); `localhost` and IP addresses always work |
| `OUTPUT_DIR` | `output` | relative to the app dir, or absolute |
| `IMAGE_MODEL` | `gpt-image-2.6-flare` | default model in the UI |
| `ENHANCE_MODEL` | `gpt-5.4-mini` | text model used by Enhance |
| `BOOK_MODEL` | `gpt-6-astra` | text model that writes Story Book ideas, outlines and page scripts |
| `CARD_MODEL` | `BOOK_MODEL` | text model that writes Flash Card templates, series plans and card text |
| `CARD_VISION_MODEL` | `ENHANCE_MODEL` | vision model that reads existing cards in the Flash Cards library |
| `REALESRGAN_BIN` | — | path to the `realesrgan-ncnn-vulkan` binary; local upscaling is off when unset or missing (e.g. inside Docker) |
| `REALESRGAN_MODELS` | `<bin dir>/models` | folder with the `.param`/`.bin` model files |
| `FAL_KEY` | — | fal.ai API key; enables the cloud upscalers (SeedVR2, Topaz). Leave empty to hide them |
| `PRINT_ROOT` | `media` | folder of your own images that the Print Sheets picker and the Flash Cards library browse (five levels deep); relative to the app folder, or absolute |

## Security

This is a single-user tool for your own machine. It has no login: anyone who can reach the port can spend your API
credit and read, change or delete everything under `output/`.

- It listens on `127.0.0.1` by default, and the Docker setup publishes the port to `127.0.0.1` only. Set
  `HOST=0.0.0.0` only on a network you trust, and never put it on the public internet without your own authentication
  in front.
- Requests are accepted only from the app's own pages. The server refuses requests whose `Origin` is another site and
  requests addressed to a hostname other than `localhost`, an IP address or an entry in `ALLOWED_HOSTS`, so a website
  open in another tab cannot drive it.
- Your API keys stay in `.env`, which is ignored by git, and are sent only to OpenAI and (when `FAL_KEY` is set) fal.ai.
- `output/` holds your images, every prompt, and the full request and reply of each model call, and `media/` holds
  your own images. Both are ignored by git; keep them out of anything you share.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

An independent project, not affiliated with or endorsed by OpenAI, fal.ai or Topaz Labs. You are responsible for the
content you generate and for following each provider's usage policies.

## License

[MIT](LICENSE) © 2026 Anand B

The bundled fonts in `public/fonts/` are separate works under the SIL Open Font License 1.1; see
[`public/fonts/OFL.txt`](public/fonts/OFL.txt).
