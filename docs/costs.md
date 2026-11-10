# AI calls and costs

Every model call goes through one module, `src/ai.js`: OpenAI text (prompt enhancement, character descriptions, book and
card writing, card vision), OpenAI images (generations and edits), fal.ai upscales and local Real-ESRGAN. Nothing else
talks to a provider. Each call, successful or failed, is written to `output/ai-calls.jsonl` with its feature, the book
or card series it belongs to, token usage, duration and cost, and its full input and output go to `output/ai-calls/`.

The **Costs** page (`/costs.html`) reads that ledger: total spend, spend per day split into text / images / upscaling,
breakdowns by activity, model and project, and every call with its input, reply and resulting images. Filters live in
the URL, and a call's detail view has its own link.

- Rates are in `PRICING` at the top of `src/ai.js` (USD per 1M tokens, from OpenAI's pricing page). Update them there when
  prices change; a model with no listed rate is still logged and shows as "unpriced".
- fal.ai costs are estimates from fal's published per-megapixel prices. Local upscales are free.
- On the first start after this was added, earlier calls are imported from `prompt-log.jsonl` and the history
  (marked "imported"; text calls are costed from their logged token usage, which was never priced before).
- To add a new kind of call, use `ai.text(...)`, `ai.image(...)`, `ai.falUpscale(...)` or `ai.localUpscale(...)`
  with a `feature` name and `refs` (for example `{ bookId }`), and add the feature to `FEATURES` in `public/costs.js`.

---
[← All guides](README.md) · [Project README](../README.md)
