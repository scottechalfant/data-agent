# BQ Data Model Reference

## Project & Conventions

- **Project:** `velky-brands`
- **Timezone:** Central Time (America/Chicago). All TIMESTAMP columns in `item_metrics` are CT. `CAST(order_date AS DATE)` is already CT — no conversion needed.
- **String escaping:** BigQuery uses `\'` for single quotes inside strings, NOT `''`.
- **Fiscal year:** Starts April 1. FY25 = Apr 2025 – Mar 2026, FY24 = Apr 2024 – Mar 2025.

## Tables Overview

| Table | Granularity | What it is |
|---|---|---|
| `analytics.item_metrics` | order × item | Primary sales/P&L fact table (~30M+ rows, 2019+) |
| `analytics.items` | item | Item dimension — attributes, lifecycle, costs, categories (~7,500 items) |
| `analytics.return_metrics` | order × item × return | Return lifecycle with financials, disposition, reasons (~346K rows) |
| `inventory.inventory_daily` | SKU × location × date | Daily inventory snapshot — units, values, costs (tens of millions rows) |
| `inventory.inventory_metrics_item_daily` | item × date | Daily inventory analytics — velocity, aging, forecast, YoY (~5.8M rows) |
| `inventory.item_sell_through` | item | Current available units, demand rate, weeks to sell through |
| `replen.demand_forecast_items_latest` | item × week | Weekly demand forecast (D2C + B2B), future-looking |
| `replen.po_status` | PO × item | Purchase orders — units ordered, received, OTW, remaining (~14.9K rows) |
| `operations.receipts` | item × container × date | Actual inventory receipts at warehouse (~44K rows, RTIC only) |
| `marketing.ga4_sessions` | session | GA4 web sessions — traffic, device, pages, cart, revenue (~90M rows) |
| `marketing.marketing_metrics` | date × marketing dims | Blends sales, sessions, ad spend for channel reporting (~1.7M rows) |
| `retail.daily` | date × location × item | Retail POS from Walmart, Target, Lowe's, West Marine (~90M rows) |
| `c2s_public.packages` | package | Physical shipping packages — tracking, dimensions, costs (~16M rows) |
| `c2s_public.itempacking` | item × UOM | Physical dimensions and weight per item |
| `c2s_public.uom` | UOM | Unit of measure lookup (each=1, case packs) |

---

## `analytics.item_metrics`

One row per order line item. Primary sales fact table. Refreshed every 15 min.

**Key columns:**

| column | type | notes |
|---|---|---|
| order_id | INT64 | Order identifier |
| orderitem_id | INT64 | Unique row key |
| item_id | INT64 | Join key to `analytics.items` and all other tables |
| title | STRING | Full SKU title |
| item_parent | STRING | Parent product name |
| item_pgc | STRING | Planning group category |
| order_date | TIMESTAMP | When order was placed (Central Time) |
| order_sales_channel | STRING | `Web`, `Amazon`, `Bulk`, `Retail`, `Customization`, `Wholesale` |
| order_sales_channel_group | STRING | `D2C` or `Wholesale` |
| order_division | STRING | e.g. `RTIC D2C`, `RTIC B2B` |
| order_business | STRING | `RTIC`, `Cuero`, `BottleKeeper` |
| order_number | INT64 | Customer order number (1 = first order) |
| order_ship_state | STRING | Shipping state |
| order_marketing_channel | STRING | e.g. `Email`, `Paid Search`, `FB & IG Paid` |
| location_name | STRING | Fulfillment location name |
| base_quantity | FLOAT64 | **Units sold — always use this**, never `uom_quantity` |
| gross_sales | FLOAT64 | List price × quantity |
| product_sales | FLOAT64 | gross_sales - discounts |
| sales | FLOAT64 | **Primary revenue** = product_sales + shipping_paid + credits |
| material_cost | FLOAT64 | Product cost |
| shipping_cost | FLOAT64 | Outbound shipping cost |
| shipping_paid | FLOAT64 | Shipping revenue from customer |
| gross_margin | FLOAT64 | product_sales - material_cost - amazon_fees - square_fees |
| net_margin | FLOAT64 | gross_margin - shipping_cost - duties - fees |
| full_price | FLOAT64 | Full list price |
| fulfillment_date | TIMESTAMP | When shipped (NULL if unfulfilled) |
| delivery_date | TIMESTAMP | Delivery date |
| package_id | INT64 | Join to `c2s_public.packages` |
| discountAmount | STRING | **Stored as STRING** — must CAST to FLOAT64 |
| myRTIC | BOOL | Whether this is a myRTIC customization order |
| myRTIC_fees | STRUCT | Nested struct: `myRTIC_fees.total`, `.face_fees`, etc. On BASE item row only |

**Critical notes:**
- `order_date` is TIMESTAMP in CT — use `CAST(order_date AS DATE)` for daily aggregation
- `discountAmount` is STRING — always `CAST(discountAmount AS FLOAT64)`
- **myRTIC fees appear TWICE** — as STRUCT on base row AND as separate fee line items. Never sum both.
- Table is very large — **always filter by date range**
- Exclude non-product items: `item_parent NOT LIKE '%Fee%' AND item_parent NOT LIKE '%Replacement%' AND item_parent NOT LIKE '%Gasket%' AND item_parent NOT LIKE '%Drain Plug%' AND item_parent NOT LIKE '% Feet' AND item_parent NOT LIKE '%Lid%'`

**Financial metrics hierarchy:**
- `sales` = product_sales + shipping_paid + credits (primary revenue)
- `gross_margin` = product_sales - material_cost - amazon_fees - square_fees
- `net_margin` = gross_margin - shipping_cost - duties - fees

---

## `analytics.items`

One row per item (SKU). Item dimension/master table.

**Key columns:**

| column | type | notes |
|---|---|---|
| id | INT64 | **Primary key** = `item_id` in all other tables |
| title | STRING | Full SKU title — **always use this when displaying items** |
| parentName | STRING | Product family (e.g. `30oz Road Trip Tumbler`) — use for product-level aggregation |
| type | STRING | Product type (e.g. `Road Trip Tumbler`, `Journey Bottle`) |
| channel | STRING | `rtic`, `cuero`, `bk`, `ccmb`, `beds` |
| size / color / name | STRING | Size, color, short name |
| lifecycle_status | STRING | See values below |
| business | STRING | `RTIC`, `Cuero`, `BottleKeeper` |
| planning_group_category | STRING | Best field for broad category grouping |
| category_path | STRING | `>` delimited: `RTIC > Drinkware > Tumblers > Road Trip Tumbler` |
| category1 / category2 / category3 | STRING | Pre-parsed category levels |
| materials_avg | FLOAT64 | Average material cost per unit |
| is_inactive | BOOL | **Legacy flag — do NOT use**. Use `lifecycle_status` instead |
| pallet_quantity | INT64 | Units per pallet |
| container_quantity | FLOAT64 | Units per container (for replenishment) |

**Lifecycle status values:**
- **Active:** `Active / evergreen`, `Active / seasonal`
- **Pre-Sale:** `Pre-Sale / setup`, `Pre-Sale / new`, `Pre-Sale / new-on-order`
- **Post-Sale:** `Post-Sale / discontinued` (still in stock), `Post-Sale / retired` (out of stock)
- Active items filter: `WHERE lifecycle_status IN ('Active / evergreen', 'Active / seasonal')`

---

## `inventory.inventory_daily`

Daily snapshot view. One row per SKU × location × date. ~10.8M rows, back to 2016.

**Key columns:**

| column | type | notes |
|---|---|---|
| date | DATE | Snapshot date — **always filter**: `WHERE date = CURRENT_DATE('America/Los_Angeles')` |
| item_id | INT64 | Same as `sku` (aliased) |
| location_name | STRING | e.g. `Katy HQ`, `Gateway`, `Hempstead`, `RJW` |
| location_type | STRING | `warehouse`, `retail`, `amazon`, `customization`, `3pl` |
| location_id | INT64 | Numeric key (2, 8, 13, 14, 16, 17, 20, 22, 25) |
| business | STRING | `RTIC` (~76%) or `Cuero` (~24%) |
| available_units | FLOAT64 | **Use this** — not `avaliable_units` (typo column) |
| total_units | FLOAT64 | on_hand - picked - committed |
| total_value | FLOAT64 | material_costs + freight allocation |
| material_costs | FLOAT64 | Material cost component |
| safety_stock | FLOAT64 | Target safety stock level (NULL for open box/clearance) |

**Critical notes:**
- `avaliable_units` is a TYPO — **always use `available_units`**
- For warehouse totals: `WHERE location_type IN ('warehouse', 'customization')`
- **`HAVING` does not work** on this view — wrap in subquery and use `WHERE`

---

## `inventory.inventory_metrics_item_daily`

Comprehensive daily inventory analytics VIEW. One row per item × date. ~5.8M rows, ~2,092 items on current date. Warehouse-only inventory, all-channel sales.

**Key columns:**

| column | type | notes |
|---|---|---|
| date | DATE | Snapshot date — **always filter by date** |
| item_id | INT64 | Join key |
| title / parent / type / pgc / pgn | STRING | Item attributes from `analytics.items` |
| lifecycle_status | STRING | **Point-in-time** — computed by view, differs from `analytics.items` |
| beginning_inventory | FLOAT64 | Previous day's ending inventory (NULL on first day) |
| units_received | INT64 | Units received at warehouse on this date |
| units_sold | FLOAT64 | Units sold on this date (all channels) |
| sales_dollars | FLOAT64 | Sales revenue on this date |
| ending_inventory | FLOAT64 | Available units at end of day (warehouse only) |
| inventory_adjustment | FLOAT64 | Unexplained change = ending - beginning - received + sold |
| material_value | FLOAT64 | Material cost of inventory on hand |
| pallets_on_hand | FLOAT64 | ending_inventory / pallet_quantity |
| safety_stock | FLOAT64 | Safety stock level |
| is_instock | INT64 | 1 if ending_inventory > 1.1 × safety_stock |
| units_on_order | INT64 | Open PO units (remaining + OTW). **Not date-varying** |
| next_arrival_date | DATE | Earliest expected PO arrival. **Not date-varying** |
| oldest_inventory_age_days | INT64 | FIFO oldest batch age (NULL if no receipts/zero inv) |
| avg_inventory_age_days | FLOAT64 | FIFO weighted-average age |
| units_sold_90d | FLOAT64 | Rolling 90-day units sold |
| daily_demand_rate | FLOAT64 | units_sold_90d / 90 (0 if no sales, never NULL) |
| weeks_to_sell_through | FLOAT64 | ending_inventory / daily_demand_rate / 7 |
| dio_days | FLOAT64 | Days Inventory Outstanding |
| inventory_turns | FLOAT64 | Annualized = daily_demand_rate × 365 / ending_inventory |
| forecast_units_30d/60d/90d/180d/270d/365d | FLOAT64 | Forecasted demand horizons. **Not date-varying** |
| prev90_unitsLY / prev90_salesLY | FLOAT64 | LY trailing 90-day sales (date-varying) |
| next90_unitsLY / next90_salesLY | FLOAT64 | LY forward 90-day sales (date-varying) |

**Critical notes:**
- **Warehouse-only** inventory (excludes customization, retail, amazon, 3pl)
- **All-channel** sales (not filtered by channel)
- `units_on_order`, `next_arrival_date`, `forecast_units_*` are **current snapshots** — same for all dates
- LY columns are properly date-varying via 1-year offset join
- Excludes items with "WHOLESALE" in title
- Complex view — always filter by date for performance

---

## `inventory.item_sell_through`

One row per item. Pre-computed sell-through analysis.

| column | type | notes |
|---|---|---|
| item_id | INT64 | Join key |
| available_units | FLOAT64 | Current warehouse + customization inventory |
| units_on_order | INT64 | remaining_units + otw_units from POs |
| total_supply | FLOAT64 | available_units + units_on_order |
| daily_demand_rate | FLOAT64 | NULL if no demand data |
| demand_source | STRING | `forecast` or `sales_history` |
| weeks_to_sell_through | FLOAT64 | days_to_sell_through / 7 |

---

## `replen.demand_forecast_items_latest`

Weekly demand forecast per item. One row per item × week.

| column | type | notes |
|---|---|---|
| date | TIMESTAMP | Forecast week start (Sunday) |
| item_id | INT64 | Join key |
| forecast_unit | STRING | Parent forecast unit (e.g. `30oz_Road_Trip_Tumbler`) |
| d2c_units | FLOAT64 | D2C forecast — **use COALESCE(d2c_units, 0)** |
| b2b_units | FLOAT64 | B2B forecast — **use COALESCE(b2b_units, 0)** |

- Total demand = `COALESCE(d2c_units, 0) + COALESCE(b2b_units, 0)`
- Future weeks only: `WHERE date > CURRENT_TIMESTAMP()`

---

## `replen.po_status`

Purchase order status VIEW. One row per PO forecast × item. ~14,920 rows (~12K closed, ~2.9K open).

| column | type | notes |
|---|---|---|
| forecast_id | INT64 | PO forecast ID — join to `operations.receipts` |
| item_id | INT64 | Join key |
| closed | BOOL | Whether PO is closed — filter `WHERE NOT closed` for active |
| vendor | STRING | Vendor name |
| title / parentName / pgc / pgn | STRING | Item attributes |
| division | STRING | `RTIC D2C`, `Wholesale`, etc. |
| ship_date | DATE | Estimated ship date (derived from multiple sources — approximate) |
| destination | STRING | `Katy HQ`, `RJW`, or `Walmart Overseas` |
| po_units | INT64 | Total units ordered |
| received_units | INT64 | Units received (from `operations.receipts`) |
| otw_units | INT64 | Units on-the-water (in transit) |
| remaining_units | INT64 | Units not yet shipped from vendor (if closed: 0; else: GREATEST(0, po_units - received - otw)) |
| excess_units | INT64 | received + otw - po_units (positive = over-received) |
| is_late | BOOL | remaining > 0 AND ship_date < current_date - 14 days |
| first_otw_delivery_date / last_otw_delivery_date | DATE | OTW delivery window |
| containers | ARRAY | Container summary — requires `UNNEST` |
| container_detail | ARRAY | Detailed container info with ports/routing — requires `UNNEST` |

**Key formulas:**
- Outstanding (not yet at warehouse) = `remaining_units + otw_units`
- Filter active POs: `WHERE NOT closed AND created > '2022-06-01'`
- `excess_units` sign is inverted: positive = over-received, negative = still outstanding

---

## `operations.receipts`

Actual inventory receipts. One row per item × container × date. ~44K rows, RTIC only. Rebuilt daily.

| column | type | notes |
|---|---|---|
| date | DATE | Date received |
| container_number | STRING | Container identifier (never NULL) |
| forecast_id | INT64 | **Primary PO join key** — join to `replen.po_status` (99.99% populated) |
| po_id | INT64 | Almost always NULL — use `forecast_id` instead |
| vendor | STRING | Almost always NULL — get vendor from `replen.po_status` via `forecast_id` |
| item_id | INT64 | Join key |
| parentName / variantName / color / size | STRING | Item attributes |
| location | STRING | Receiving location (**column is `location`, NOT `location_name`**) |
| location_id | INT64 | Location ID |
| units_received | INT64 | Units received (can be 0 for pre-receipt rows) |
| rate | FLOAT64 | Unit material cost (never NULL, avg ~$29) |
| business | STRING | Always `RTIC` — Cuero not present |
| freight | STRUCT | Freight costs: `.freight_base_per_unit`, `.freight_assessorial_per_unit`, `.duty_per_unit`, `.shipment_id` (~45% populated) |

**Landed cost:** `rate + COALESCE(freight.freight_base_per_unit, 0) + COALESCE(freight.freight_assessorial_per_unit, 0) + COALESCE(freight.duty_per_unit, 0)`

---

## `analytics.return_metrics`

One row per order × item × return. Covers return lifecycle. ~346K rows.

**Key columns:**

| column | type | notes |
|---|---|---|
| order_id / item_id / return_id | INT64 | Identifiers |
| order_date / rma_date / return_received_date | TIMESTAMP | Key dates (NULL received = pending) |
| product | STRING | Parent product name |
| units_sold / units_returned | FLOAT64 / INT64 | Original units and returned units |
| sales / returned_sales / refunded_sales | FLOAT64 | Revenue metrics |
| return_shipping_cost | FLOAT64 | Inbound return shipping cost |
| replacement_material_cost | FLOAT64 | Cost of replacement items sent |
| disposition | STRING | `Return to Inventory`, `Scrap`, `Resell As Open Box`, `Unspecified`, NULL |
| resolution | STRING | `refund`, `replace`, `other`, NULL |
| reasons | STRING | Pipe-delimited return reasons |
| is_warranty | BOOL | Whether warranty claim |

- `returned_sales ≠ refunded_sales` — many returns are replacements
- Return rate = `SUM(units_returned) / SUM(units_sold)`

---

## `marketing.ga4_sessions`

One row per GA4 web session. ~90.8M rows from April 2023+. Rebuilt daily.

**Key columns:**

| column | type | notes |
|---|---|---|
| session_id | STRING | Unique session key |
| date | DATE | Session date — **always filter by date** |
| transaction_id | STRING | GA4 order ID — joins to `c2s_public.orders.unique_id` (NOT `order_id`) |
| marketing_channel | STRING | `Paid Search`, `Meta`, `Email`, `Direct`, `Organic Search`, `Affiliates`, etc. |
| platform | STRING | `Google`, `Meta`, `Bing`, `Direct`, `Klaviyo`, `Attentive`, etc. |
| campaign / original_campaign | STRING | `original_campaign` = raw GA4 name — **use for specific campaign filtering** |
| device_category | STRING | `mobile`, `desktop`, `tablet` |
| new_visits | INT64 | 1 if new user |
| pageviews | INT64 | Page view count |
| is_bounce | BOOL | pageviews ≤ 1 |
| transactions | INT64 | 1 if purchase event |
| transaction_revenue | FLOAT64 | GA4-reported revenue (may differ from item_metrics) |
| items_in_cart | ARRAY | Items added to cart: `item_id`, `quantity`, `price` |
| pages | ARRAY | Page views: `path`, `item_type`, `category1`, `sales`, `gross_margin`, `units`, `is_enter`, `is_exit`, `color`, `size` |
| ab_tests | ARRAY | A/B test assignments: `campaign`, `variant` |

**Notes:**
- CVR = `COUNTIF(transactions > 0) / COUNT(*)`
- ARRAY columns require `UNNEST`: `FROM marketing.ga4_sessions s, UNNEST(pages) p`
- `pages[].sales` uses last-visit-wins per page type in converting sessions only

---

## `marketing.marketing_metrics`

Daily marketing performance table. Blends sales (item_metrics), sessions (ga_sessions), and ad spend (marketing_cost) via FULL OUTER JOIN. One row per date × marketing dimension. ~1.68M rows, 2015+. Rebuilt daily.

**Key columns:**

| column | type | notes |
|---|---|---|
| date | DATE | Calendar date |
| business | STRING | `RTIC`, `BottleKeeper`, `Cuero` |
| sales_channel | STRING | `Web`, `Amazon`, `Bulk`, `Customization`, `Retail`, `Dropship` |
| marketing_channel | STRING | **Primary grouping** — `Meta`, `Paid Shopping`, `Paid Search`, `Email`, `SMS`, `Direct`, `Organic Search`, `Affiliates`, `TikTok`, etc. |
| platform | STRING | `Google`, `Meta`, `Klaviyo`, `Amazon`, `Attentive`, `Bing`, etc. |
| campaign / campaign_group / campaign_type | STRING | Campaign dimensions |
| cost | FLOAT64 | Ad spend (NULL for organic/unpaid channels) |
| impressions | INT64 | Ad impressions (NULL for non-paid) |
| visits | INT64 | Web sessions (NULL for non-web channels like Amazon, Phone) |
| transactions | INT64 | Order count = COUNT(DISTINCT order_id) |
| sales | FLOAT64 | Total revenue from item_metrics |
| net_margin | FLOAT64 | Net margin from item_metrics |
| new_buyers | INT64 | First-time buyers (order_number = 1) |
| new_buyer_sales | FLOAT64 | Sales from first-time buyers |
| buyers | INT64 | Distinct customer count |
| transactions_phone_bulk / sales_phone_bulk / net_margin_phone_bulk | | **Subsets** of main metrics for Phone Bulk — NOT additive |
| messages_sent / email_opens | INT64 | Email/SMS metrics (NULL unless cost data exists) |

**Critical notes:**
- **Retail partner sales excluded** — use `retail.daily` for Walmart/Target/Lowe's/West Marine
- NULL metrics = that data source had no match for the dimension combo
- `cost` for Email/SMS = platform fees (Klaviyo, Attentive)
- Amazon `new_buyers` = `transactions` (no customer history from Amazon)
- ROAS: `SAFE_DIVIDE(SUM(sales), NULLIF(SUM(cost), 0))`

---

## `retail.daily`

Daily retail POS view. One row per date × location × item. ~90.7M rows from Nov 2023+.

| column | type | notes |
|---|---|---|
| date | DATE | POS date |
| retailer | STRING | `Walmart`, `Target`, `Lowe's`, `West Marine` |
| item_id | STRING | **Stored as STRING** — use `SAFE_CAST(item_id AS INT64)` to join |
| location_number / location_name | STRING | Store identifier and name |
| state / zip / city | STRING | Store location |
| channel | STRING | `In-store` or `e-Commerce` (DC fulfillment) |
| sales_net | FLOAT64 | Net POS sales — **use for revenue** |
| units_net | FLOAT64 | Net units — **use for unit counts** |
| inventory_units | FLOAT64 | On-hand units at location |
| est_cost | FLOAT64 | Estimated RTIC wholesale price per unit (NULL for ~13% of rows) |
| category1 / category2 / category3 | STRING | Category levels |
| retailer_item_number / retailer_item_name | STRING | Retailer's own item identifiers |

**Notes:**
- `Lowe's` has curly apostrophe: `WHERE retailer = 'Lowe\'s'`
- `est_cost` is wholesale price TO retailer, not COGS. RTIC revenue estimate: `units_net * est_cost`
- Rows only exist when there's activity (inventory, sales, or returns non-zero)

---

## `c2s_public.packages`

One row per shipping package. Join: `item_metrics.package_id = packages.id`

| column | type | notes |
|---|---|---|
| id | INT64 | Primary key — matches `item_metrics.package_id` |
| status | STRING | `Delivery`, `In Transit`, `Exception`, NULL |
| accrual_cost / billed_cost | STRING | **CAST to FLOAT64** — estimated vs actual shipping cost |
| packed_at / delivered_at | TIMESTAMP | When packed / delivered |
| void | BOOL | Filter `WHERE void IS NULL` to exclude voided |
| length/width/height/weight | STRING | All STRING — CAST to FLOAT64 |

---

## Joins

**Universal join key: `item_id`** = `analytics.items.id` in all tables.

| From | To | Join |
|---|---|---|
| item_metrics | items | `items.id = item_metrics.item_id` |
| item_metrics | packages | `packages.id = item_metrics.package_id` |
| receipts | po_status | `po_status.forecast_id = receipts.forecast_id` |
| ga4_sessions | orders | `transaction_id = orders.unique_id` (NOT order_id) |
| retail.daily | items | `SAFE_CAST(retail.daily.item_id AS INT64) = items.id` |
| inventory_metrics_item_daily | items | `items.id = imd.item_id` |
| marketing_metrics | — | No item_id — keyed by date × marketing dimensions |

**Inventory + sales don't join on date** — aggregate each separately, then join on `item_id`.

## `category_path` parsing

`RTIC > Drinkware > Tumblers > Road Trip Tumbler` — use `SPLIT(category_path, ' > ')`:
- `[SAFE_OFFSET(0)]` → brand, `[SAFE_OFFSET(1)]` → department, `[SAFE_OFFSET(2)]` → sub-department

Or use `analytics.items.category1/2/3` or `planning_group_category`.

## Key Business Rules

- **D2C channels:** `order_sales_channel_group = 'D2C'`
- **New customers:** `order_number = 1`
- **Active items:** `lifecycle_status IN ('Active / evergreen', 'Active / seasonal')`
- **Warehouse inventory:** `location_type IN ('warehouse', 'customization')`
- **Current inventory:** `WHERE date = CURRENT_DATE('America/Los_Angeles')`
- **Buffer = available_units - safety_stock** (negative = below safety stock)
- **Weeks of supply = available_units / avg_weekly_demand**
- **Exclude non-product items:** `item_parent NOT LIKE '%Fee%'` and similar filters
