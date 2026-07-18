---
description: Stripe via MCP tools — payments, subscriptions, invoices, billing. Load for any Stripe/billing query.
triggers:
  - "stripe"
  - "subscription"
  - "invoice"
  - "mrr"
  - "churn"
  - "billing"
  - "refund"
  - "trial_started"
  - "invoice_paid"
---

# Stripe MCP

Guide for using Stripe via MCP tools. Based on official Stripe best practices from github.com/stripe/ai.

## Pagination — CRITICAL

Stripe API returns max 100 items per request (default: 10). You MUST paginate to get complete results.

1. **Always set `limit: 100`** for list operations to minimize round-trips.
2. **Always check `has_more`** in the response — if `true`, there are more results.
3. **Use `starting_after`** with the last object's ID to fetch the next page.
4. **Loop until `has_more: false`** — never assume a single request returns all data.
5. **Report exact totals**, not "100+" — paginate to count everything.

### Pagination pattern
```
Page 1: list(limit=100)                          → get data + has_more + last ID
Page 2: list(limit=100, starting_after=last_id)  → get data + has_more + last ID
...repeat until has_more=false
```

## API version

Latest Stripe API version: **2026-03-25.dahlia**. Use latest unless user specifies otherwise.

## Integration routing

| Building…                            | Recommended API                     |
| ------------------------------------ | ----------------------------------- |
| One-time payments                    | Checkout Sessions                   |
| Custom payment form with embedded UI | Checkout Sessions + Payment Element |
| Saving a payment method for later    | Setup Intents                       |
| Subscriptions or recurring billing   | Billing APIs + Checkout Sessions    |

## Query best practices

- **Filter by status** when listing subscriptions: `active`, `past_due`, `trialing`, `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, `paused`.
- **Use `customer` filter** to scope queries to a specific customer.
- **Prefer targeted queries** over broad fetches — filter by date range, status, or customer.
- **For aggregates** (counts, sums): paginate through all results and compute locally.
- **For search**: use Stripe Search API (`/v1/subscriptions/search`) with query syntax for complex filters.
