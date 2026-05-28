# WOWstampa Reviews

Standalone Shopify app for managing custom product reviews and exposing them to a Shopify theme section.

## Features

- Admin page for manual product reviews.
- CSV import with optional customer photo URLs.
- Public JSON endpoint for storefront rendering.
- Prisma/Postgres persistence.
- Shopify theme section available in `theme/wowstampa-custom-reviews-section.liquid`.
- CSV sample available in `examples/wowstampa-reviews-sample.csv`.

## Environment

Copy `.env.example` to `.env` and fill:

```bash
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SCOPES=read_products
SHOPIFY_APP_URL=
DATABASE_URL=
DIRECT_URL=
```

## Commands

```bash
npm install
npm run render-build
npm run render-start
```

The theme section should call:

```text
https://wowstampa-reviews-app.onrender.com/api/reviews
```

## Deployment Notes

Render environment variables:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SCOPES`
- `DATABASE_URL`
- `DIRECT_URL`

Use `render.yaml` as the Render Blueprint.
