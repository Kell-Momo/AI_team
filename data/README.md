# Sample data: Saveurs de Douala (SYNTHETIC)

**All data in this folder is synthetic.** "Saveurs de Douala" is a fictional food business in
Douala, Cameroon. No row is real customer, sales or social-media data.

The CSVs are produced by a seeded, deterministic generator (same seed, byte-identical files):

```
npm run data:generate                          # writes data/*.csv (seed 237)
npx tsx scripts/generate-data.ts --out <dir> --seed <int>
```

## Files

| File | Columns |
|---|---|
| `posts.csv` | post_id, posted_at, platform, format, pillar, language, post_hour, has_price, has_cta, origin, promo_code, caption |
| `post_metrics.csv` | post_id, reach, likes, comments, shares, saves, link_clicks |
| `ad_spend.csv` | ad_date, campaign_id, platform, spend_xaf, impressions, clicks, promo_code |
| `sales.csv` | order_id, order_date, channel, promo_code, amount_xaf |

- Period: 2026-07-01 to 2026-10-20. `posted_at` is local Douala time (WAT, UTC+1), `YYYY-MM-DD HH:MM:SS`.
- `origin = existing` for posts up to 2026-09-15 (the audit set), `origin = app` from 2026-09-16.
- Amounts are in FCFA (XAF). Empty `promo_code` means none.
- Each of the 5 promo codes belongs to exactly one ad campaign and appears on promo posts and orders.

## Planted patterns

The generator builds these effects in on purpose so there is something true for the agents to find.
They are effects inside the generator, not findings from real data:

- Reels engage more than carousels, which engage more than images and text. Reels also reach more people.
- Evening posts (18:00–21:59) engage more than daytime posts.
- Pidgin posts engage more than French ones, and French more than English ones.
- Behind-the-scenes and customer-story posts engage more than menu and promo posts.
- A WhatsApp CTA and a visible price each raise link clicks.
- Promo codes return very different sales per FCFA of ad spend.
- App posts (`origin = app`) use the stronger patterns more often than existing posts.

Exactly **3 rows in `post_metrics.csv` are deliberately invalid** (reach = 0, or reach lower than
likes + comments + shares + saves). They exercise the Zetaris data-quality rule
`reach > 0 AND engagements <= reach`. The generator prints their post_ids.
