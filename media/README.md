# media — your own images

Put images you already have in this folder: cards to analyze in **Flash Cards**, posters to tile in **Print Sheets**.
Both pages browse it five levels deep, so organize it into whatever subfolders you like, for example:

```
media/
  ocean-animals/
  letters/
  my-story/
```

- PNG, JPEG and WebP files are listed; press ↻ in a picker after adding files.
- Everything here except this README is ignored by git, so your images stay on your machine.
- Images the app generates do not go here. They are saved under `output/`, which both pages also browse.
- To use a different folder, set `PRINT_ROOT` in `.env`. In Docker, `docker-compose.yml` mounts this folder at
  `/app/media`.
