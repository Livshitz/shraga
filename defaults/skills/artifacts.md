---
description: Create and iterate on self-contained visual HTML artifacts (ad creatives, banners, cards) that render live in the user's browser.
---

# Artifacts — HTML Creative Builder

You can create and iterate on visual HTML artifacts (ad creatives, banners, cards, etc.) that render live in the user's browser.

## How It Works

Write a self-contained HTML file using the `Write` tool. Include an artifact metadata comment as the **first line**:

```html
<!-- artifact: {"title": "Summer Sale Banner", "dimensions": [1080, 1080]} -->
```

The system detects this comment, registers the artifact, and shows it in a live preview panel.

## To Update an Existing Artifact

**Full rewrite** — use `Write` with the artifact `id` in the metadata:

```html
<!-- artifact: {"title": "Summer Sale Banner", "dimensions": [1080, 1080], "id": "art_xxx"} -->
```

**Incremental edit** — use the `Edit` tool on the same file path. The system re-reads the file after edit and refreshes the preview. The `<!-- artifact: ... -->` comment must remain in the file. This is the preferred approach for small changes (tweaking colors, text, spacing).

The artifact ID is returned to you after creation. Always include it when doing a full rewrite.

## Visual Feedback

After creating or updating an artifact, export a screenshot to verify the visual result:

```bash
curl -s -o /tmp/artifact-preview.png -X POST \
  "http://localhost:${PORT}/api/artifacts/${SHRAGA_SESSION_ID}/${ARTIFACT_ID}/export" \
  -H 'Content-Type: application/json' \
  -H "x-internal-token: $INTERNAL_API_TOKEN" \
  -d '{"dimensions": [1080, 1080]}'
```

- `$PORT`, `$SHRAGA_SESSION_ID`, and `$INTERNAL_API_TOKEN` are already in your environment.
- Replace `$ARTIFACT_ID` with the actual artifact ID (e.g. `art_mpmgeqrw_o7tn8r`).
- The `x-internal-token` header is **required** — without it you get `{"error":"Missing token"}`.

Then read `/tmp/artifact-preview.png` to see the rendered output. This gives you visual context to self-correct layout issues, color contrast, etc.

**Always screenshot after creation** to verify the result before telling the user it's ready.

## Rules

1. **Self-contained HTML** — everything in one file. No external dependencies except CDN links.
2. **Always include Tailwind** — add this in `<head>`:
   ```html
   <script src="https://cdn.tailwindcss.com"></script>
   ```
3. **Set exact dimensions** — the HTML `<body>` should match the artifact dimensions. Use:
   ```html
   <body class="m-0 p-0 overflow-hidden" style="width: {W}px; height: {H}px;">
   ```
4. **Use web fonts from Google Fonts CDN** when needed.
5. **Images**: use placeholder services (picsum.photos, placehold.co) or inline SVG/data URIs. Never reference local files.
6. **File path**: keep it consistent for the same artifact so `Edit` works. Default to the user's folder: `{WORKSPACE_DIR}/users/{SHRAGA_USER_UID}/artifacts/{title-slug}.html`. To make an artifact visible to all users, use the shared root: `{WORKSPACE_DIR}/artifacts/{title-slug}.html` — only do this when explicitly asked.

## Dimension Presets

| Preset | Dimensions | Use Case |
|--------|-----------|----------|
| fb-feed | 1080×1080 | Facebook/Instagram feed post |
| fb-story | 1080×1920 | Facebook/Instagram story |
| fb-landscape | 1200×628 | Facebook link ad |
| ig-square | 1080×1080 | Instagram square post |
| ig-landscape | 1080×566 | Instagram landscape |
| banner-leaderboard | 728×90 | Website banner |
| banner-medium | 300×250 | Medium rectangle |

## Template

```html
<!-- artifact: {"title": "My Creative", "dimensions": [1080, 1080]} -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
    body { font-family: 'Inter', sans-serif; }
  </style>
</head>
<body class="m-0 p-0 overflow-hidden" style="width: 1080px; height: 1080px;">
  <!-- Your creative content here -->
</body>
</html>
```

## Export

Artifacts can be exported to PNG via `POST /api/artifacts/$SHRAGA_SESSION_ID/$ARTIFACT_ID/export` (with `x-internal-token: $INTERNAL_API_TOKEN` header). The export uses Puppeteer server-side at the exact dimensions specified.

## Iteration Flow

1. Create the initial artifact with `Write`
2. Screenshot it to verify the visual result
3. Wait for user feedback
4. Apply changes with `Edit` (preferred) or `Write` (full rewrite)
5. Screenshot again to verify
6. Repeat until approved
7. Export to PNG when ready

## Tips for Ad Creatives

- Use bold, high-contrast text — it must be readable at small sizes
- Keep copy short: headline (5-7 words max), subtext (1 line)
- Strong CTA button with contrasting color
- Use brand colors if provided
- Leave breathing room — don't fill every pixel
- Test with both light and dark backgrounds
- For FB ads: text overlay should be <20% of image area
