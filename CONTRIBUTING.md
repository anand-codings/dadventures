# Contributing

Thanks for taking a look. This is a small tool, and issues and pull requests are welcome.

## Getting set up

```bash
cp .env.example .env     # add your OPENAI_API_KEY
npm start                # → http://127.0.0.1:53405
```

Node 22 or newer; there is nothing to install. Generations, enhancements and book or card steps call the OpenAI API
and are billed to your key, so use low quality and small sizes while testing. To try a change without touching your
own data, run a second copy on another port with its own output folder:

```bash
PORT=53500 OUTPUT_DIR=/tmp/studio-test npm start
```

## Where things are

- [`src/`](src/README.md): the server, one file per feature.
- [`public/`](public/README.md): the pages, with no build step.
- [`docs/`](docs/README.md): the feature guides. Update the matching guide when behaviour changes.

## Ground rules

- **No dependencies.** The app runs on Node's standard library alone; please keep it that way.
- **Model calls go through `src/ai.js`**, so every call is logged and costed. See [`src/README.md`](src/README.md).
- **Never commit `.env`, `output/` or the contents of `media/`.** They are ignored by git; check `git status` before
  committing, and keep keys, prompts and personal images out of issues and screenshots too.
- Run `npm run check` (a syntax check of every script) before opening a pull request, and say in the pull request
  what you tried by hand, since there is no automated test suite.

## Reporting bugs

Open an issue with what you did, what you expected and what happened, plus your OS and Node version. For security
problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
