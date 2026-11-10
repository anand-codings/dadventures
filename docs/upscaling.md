# Upscaling (local Real-ESRGAN or fal.ai cloud)

Every image has an **Upscale** box with one dropdown that lists every available upscaler, grouped by where it runs.
The note next to it shows the output size, the estimated cost and a rough duration before you click.

**Local — Real-ESRGAN (free).** Runs your `realesrgan-ncnn-vulkan` binary (GPU via Vulkan/Metal).
`realesrgan-x4plus-anime` (default — cleanest edges on flat-color illustrations and posters),
`realesrgan-x4plus` (photos/general), `realesr-animevideov3` (fast). Scale ×2, ×3 or ×4.
A 2048×2048 poster becomes 8192×8192 in about 10 s (anime) or 30 s (x4plus) on a recent Apple Silicon Mac.

**Cloud — fal.ai (needs `FAL_KEY`).** Billed per output megapixel on your fal account; estimates below are from fal's
published rates and are also stored on the record.

| Option | Best for | Scale | Price | 2048² → ×4 (67 MP) |
|---|---|---|---|---|
| SeedVR2 | photoreal GPT Image output, restoration, best value | ×2–×8 | $0.001 / MP | ≈ $0.07 |
| Topaz Gigapixel Standard V2 | faithful general photo upscaling | ×2–×4 | $0.08 per started 24 MP | $0.24 |
| Topaz Gigapixel High Fidelity V3 | professional detail preservation | ×2–×4 | $0.08 per started 24 MP | $0.24 |
| Topaz Gigapixel CGI | artwork, renders, flat color | ×2–×4 | $0.08 per started 24 MP | $0.24 |
| Topaz Wonder 3.5 | generative — rebuilds detail in small/blurry sources | ×2–×4 | $0.08 per started 8 MP | $0.72 |

All outputs are PNG. The server uploads the source to fal storage, submits to fal's queue, polls until done, and
downloads the result; nothing else leaves your machine. fal runs a safety checker — a rejected image comes back as an
error in the Upscale box. Cloud upscaling also works inside Docker, where the local binary is unavailable.

Upscaled images are separate history records marked **UPSCALED ×N** with their pixel size, model, timing, cost and a
link to the source; the source shows chips for each upscale. They inherit the prompts, tags (plus `upscaled`) and
title, carry the prompt in their PNG metadata, and can be filtered with the **⬆ Upscaled** toggle. Limit: 16384 px per edge.

---
[← All guides](README.md) · [Project README](../README.md)
