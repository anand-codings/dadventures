# Security

## Reporting a vulnerability

Please do not open a public issue. Use the repository's **Security → Report a vulnerability** page on GitHub
(private vulnerability reporting) and include how to reproduce the problem.

## What to expect from this app

Dadventures is a single-user tool meant to run on your own machine. It has no login. By design:

- it listens on `127.0.0.1` unless you change `HOST`;
- it refuses requests from other websites (`Origin` check) and requests addressed to unknown hostnames
  (`Host` check, extended with `ALLOWED_HOSTS`);
- API keys are read from `.env` and sent only to OpenAI and, when configured, fal.ai;
- everything it stores stays under `output/` on your disk.

Exposing it to a network you do not trust, or to the internet, is outside what it is built for. Reports about ways
around the checks above, path handling, or anything that leaks keys or files are very welcome.
