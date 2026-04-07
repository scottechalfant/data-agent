# BQ Data Model Reference

## Project & Conventions

- **Project:** `velky-brands`
- **Timezone:** Central Time (America/Chicago). All TIMESTAMP columns in `item_metrics` are CT. `CAST(order_date AS DATE)` is already CT — no conversion needed.
- **String escaping:** BigQuery uses `\'` for single quotes inside strings, NOT `''`.

## Tables Overview

| Table | Granularity | What it is |
|---|---|---|
| `analytics.item_metrics` | order × item | Primary sales/P&L fact table (~30M+ rows, 2019+) |
| `analytics.items` | item | Item dimension — attributes, lifecycle, costs, categories (~7,500 items) |
| `analytics.return_metrics` | order × item × return | Return lifecycle with financials, disposition, reasons (~346K rows) |
| `inventory.inventory_daily` | SKU × location × date | Daily inventory snapshot — units, values, costs (tens of millions rows) |
| `inventory.item_sell_through` | item | Current available units, demand rate, weeks to sell through |
| `replen.demand_forecast_items_latest` | item × week | Weekly demand forecast (D2C + B2B), future-looking |
| `replen.po_status` | PO × item | Purchase orders — units ordered, received, OTW, remaining |
| `operations.receipts` | item × container × date | Actual inventory receipts at warehouse |
| `marketing.ga4_sessions` | session | GA4 web sessions — traffic, device, pages, cart, revenue (~90M rows) |
| `retail.daily` | date × location × item | Retail POS from Walmart, Target, Lowe's, West Marine |
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
- Exclude non-product items from unit counts:
  ```sql
  AND item_parent NOT LIKE '%Fee%'
  AND item_parent NOT LIKE '%Replacement%'
  AND item_parent NOT LIKE '%Gasket%'
  AND item_parent NOT LIKE '%Drain Plug%'
  AND item_parent NOT LIKE '% Feet'
  AND item_parent NOT LIKE '%Lid%'
  ```

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
| size | STRING | Size descriptor |
| color | STRING | Color name |
| name | STRING | Short item name |
| lifecycle_status | STRING | See values below |
| business | STRING | `RTIC`, `Cuero`, `BottleKeeper` |
| planning_group_category | STRING | Best field for broad category grouping |
| planning_group_name | STRING | Planning group name |
| category_path | STRING | `>` delimited: `RTIC > Drinkware > Tumblers > Road Trip Tumbler` |
| category1 / category2 / category3 | STRING | Pre-parsed category levels |
| materials_avg | FLOAT64 | Average material cost per unit |
| is_inactive | BOOL | **Legacy flag — do NOT use**. Use `lifecycle_status` instead |
| visible_on_rticweb | BOOL | Visible on RTIC website |
| approx_create_date | DATE | Approximate item creation date |
| pallet_quantity | INT64 | Units per pallet |
| case_quantity | INT64 | Units per case |

**Lifecycle status values:**
- **Active:** `Active / evergreen`, `Active / seasonal`
- **Pre-Sale:** `Pre-Sale / setup`, `Pre-Sale / new`, `Pre-Sale / new-on-order`
- **Post-Sale:** `Post-Sale / discontinued` (still in stock), `Post-Sale / retired` (out of stock)
- Active items filter: `WHERE lifecycle_status IN ('Active / evergreen', 'Active / seasonal')`

---

## `inventory.inventory_daily`

Daily snapshot view. One row per SKU × location × date.

**Key columns:**

| column | type | notes |
|---|---|---|
| date | DATE | Snapshot date — **always filter**: `WHERE date = CURRENT_DATE('America/Los_Angeles')` |
| item_id | INT64 | Same as `sku` (aliased) |
| location_name | STRING | e.g. `Katy HQ`, `Gateway`, `Hempstead` |
| location_type | STRING | `warehouse`, `retail`, `amazon`, `customization`, `3pl` |
| business | STRING | `RTIC` or `Cuero` |
| available_units | FLOAT64 | **Use this** — not `avaliable_units` (typo column) |
| total_units | FLOAT64 | on_hand - picked - committed |
| total_value | FLOAT64 | material_costs + freight allocation |
| avg_unit_value | FLOAT64 | total_value / total_units |
| material_costs | FLOAT64 | Material cost component |
| safety_stock | FLOAT64 | Target safety stock level (NULL for open box/clearance) |
| category_path | STRING | Category hierarchy |
| title | STRING | Full SKU title |

**Critical notes:**
- `avaliable_units` is a TYPO — **always use `available_units`**
- For warehouse totals: `WHERE location_type IN ('warehouse', 'customization')`
- **`HAVING` does not work** on this view — wrap in subquery and use `WHERE`:
  ```sql
  SELECT item_id, available_units FROM (
    SELECT item_id, SUM(available_units) AS available_units
    FROM inventory.inventory_daily WHERE ...
    GROUP BY item_id
  ) WHERE available_units > 0
  ```

---

## `inventory.item_sell_through`

One row per item. Pre-computed sell-through analysis.

| column | type | notes |
|---|---|---|
| item_id | INT64 | Join key |
| title | STRING | Full SKU title |
| parent | STRING | Parent product name |
| type | STRING | Product type |
| pgc | STRING | Planning group category |
| lifecycle_status | STRING | Item lifecycle status |
| available_units | FLOAT64 | Current warehouse + customization inventory |
| units_on_order | INT64 | remaining_units + otw_units from POs |
| total_supply | FLOAT64 | available_units + units_on_order |
| daily_demand_rate | FLOAT64 | NULL if no demand data |
| demand_source | STRING | `forecast` or `sales_history` |
| days_to_sell_through | FLOAT64 | available_units / daily_demand_rate |
| weeks_to_sell_through | FLOAT64 | days_to_sell_through / 7 |

**Notes:**
- For excess inventory: `COALESCE(weeks_to_sell_through, 9999) > 26`
- Does NOT include material costs — join to `inventory.inventory_daily` for those

---

## `replen.demand_forecast_items_latest`

Weekly demand forecast per item. One row per item × week.

| column | type | notes |
|---|---|---|
| date | TIMESTAMP | Forecast week start (Sunday) |
| item_id | INT64 | Join key |
| forecast_unit | STRING | Parent forecast unit (e.g. `30oz_Road_Trip_Tumbler`) |
| category1 / category2 | STRING | Category levels |
| d2c_units | FLOAT64 | D2C forecast — **use COALESCE(d2c_units, 0)** |
| b2b_units | FLOAT64 | B2B forecast — **use COALESCE(b2b_units, 0)** |
| created | TIMESTAMP | Forecast version date |

- Total demand = `COALESCE(d2c_units, 0) + COALESCE(b2b_units, 0)`
- Future weeks only: `WHERE date > CURRENT_TIMESTAMP()`

---

## `replen.po_status`

Purchase order status. One row per PO forecast × item.

| column | type | notes |
|---|---|---|
| forecast_id | INT64 | PO forecast ID — join to `operations.receipts` |
| item_id | INT64 | Join key |
| closed | BOOL | Whether PO is closed — filter `WHERE NOT closed` for active |
| vendor | STRING | Vendor name |
| title | STRING | Item title |
| parentName | STRING | Parent product name |
| ship_date | DATE | Estimated ship/departure date |
| destination | STRING | Destination location |
| po_units | INT64 | Total units ordered |
| received_units | INT64 | Units received at warehouse |
| otw_units | INT64 | Units on-the-water (in transit) |
| remaining_units | INT64 | Units not yet shipped from vendor (excludes OTW) |
| is_late | BOOL | Whether PO is late |
| first_otw_delivery_date | DATE | First OTW delivery date |
| last_otw_delivery_date | DATE | Last OTW delivery date |
| containers | ARRAY | Container-level summary — requires `UNNEST` |
| container_detail | ARRAY | Detailed container info — requires `UNNEST` |

**Key formulas:**
- Outstanding (not yet at warehouse) = `remaining_units + otw_units`
- Filter active POs: `WHERE NOT closed AND created > '2022-06-01'`

---

## `operations.receipts`

Actual inventory receipts. One row per item × container × date.

| column | type | notes |
|---|---|---|
| date | DATE | Date received |
| container_number | STRING | Container identifier |
| forecast_id | INT64 | Join to `replen.po_status.forecast_id` |
| item_id | INT64 | Join key |
| parentName | STRING | Parent product name |
| location | STRING | Receiving location (column is `location`, NOT `location_name`) |
| units_received | INT64 | Units received (can be 0) |
| rate | FLOAT64 | Unit cost at time of receipt |
| business | STRING | `RTIC` |

---

## `analytics.return_metrics`

One row per order × item × return. Covers return lifecycle.

**Key columns:**

| column | type | notes |
|---|---|---|
| order_id | INT64 | Join to `item_metrics` |
| item_id | INT64 | Join key |
| return_id | INT64 | RMA identifier |
| order_date | TIMESTAMP | Original order date |
| rma_date | TIMESTAMP | When RMA was created |
| return_received_date | TIMESTAMP | When item received back (NULL = pending) |
| product | STRING | Parent product name |
| units_sold | FLOAT64 | Units on original order |
| units_returned | INT64 | Physical units received back |
| sales | FLOAT64 | Revenue on original order × item |
| returned_sales | FLOAT64 | Value of returned units at original sale price |
| refunded_sales | FLOAT64 | Money actually refunded (only for resolution='refund') |
| return_shipping_cost | FLOAT64 | Inbound return shipping cost |
| replacement_material_cost | FLOAT64 | Cost of replacement items sent |
| disposition | STRING | `Return to Inventory`, `Scrap`, `Resell As Open Box`, `Unspecified`, NULL |
| resolution | STRING | `refund`, `replace`, `other`, NULL |
| reasons | STRING | Pipe-delimited return reasons |
| is_warranty | BOOL | Whether warranty claim |

**Notes:**
- `returned_sales ≠ refunded_sales` — many returns are replacements
- Return rate = `SUM(units_returned) / SUM(units_sold)`
- Pending returns: `return_received_date IS NULL`

---

## `marketing.ga4_sessions`

One row per GA4 web session. ~90M rows from April 2023+.

**Key columns:**

| column | type | notes |
|---|---|---|
| session_id | STRING | Unique session key |
| date | DATE | Session date |
| transaction_id | STRING | GA4 order ID — joins to `c2s_public.orders.unique_id` (NOT `order_id`) |
| source_medium | STRING | Raw GA4 source/medium |
| marketing_channel | STRING | Standardized: `Paid Search`, `Meta`, `Email`, `Direct`, `Organic Search`, `Affiliates` |
| platform | STRING | Ad platform: `Google`, `Meta`, `Bing`, `Direct` |
| campaign | STRING | Campaign name (may be overridden by mapping) |
| original_campaign | STRING | **Raw GA4 campaign** — use for filtering by specific campaigns |
| device_category | STRING | `mobile`, `desktop`, `tablet` |
| new_visits | INT64 | 1 if new user |
| pageviews | INT64 | Page view count |
| is_bounce | BOOL | pageviews ≤ 1 |
| transactions | INT64 | 1 if purchase event |
| transaction_revenue | FLOAT64 | GA4-reported revenue (may differ from item_metrics) |
| landing_page_path | STRING | First page URL |
| items_in_cart | ARRAY | Items added to cart: `item_id`, `quantity`, `price` |
| pages | ARRAY | Page views with `path`, `item_type`, `sales`, `is_enter`, `is_exit` |
| ab_tests | ARRAY | A/B test assignments: `campaign`, `variant` |

**Notes:**
- CVR = `COUNTIF(transactions > 0) / COUNT(*)`
- ARRAY columns require `UNNEST`: `FROM marketing.ga4_sessions s, UNNEST(pages) p`
- **Always filter by `date` range** — table is very large

---

## `retail.daily`

Daily retail POS data. One row per date × location × item.

| column | type | notes |
|---|---|---|
| date | DATE | POS date |
| retailer | STRING | `Walmart`, `Target`, `Lowe's`, `West Marine` |
| item_id | STRING | **Stored as STRING** — use `SAFE_CAST(item_id AS INT64)` to join |
| location_number | STRING | Store/DC identifier |
| location_name | STRING | Store name |
| state | STRING | State |
| channel | STRING | `In-store` or `e-Commerce` |
| sales_net | FLOAT64 | Net POS sales (after returns) — **use for revenue** |
| units_net | FLOAT64 | Net units (after returns) — **use for unit counts** |
| inventory_units | FLOAT64 | On-hand units at location |
| est_cost | FLOAT64 | Estimated RTIC wholesale price per unit |
| category1 / category2 / category3 | STRING | Category levels |

**Notes:**
- `Lowe's` has curly apostrophe: `WHERE retailer = 'Lowe\'s'`
- `est_cost` is wholesale price TO retailer, not COGS
- Rows only exist when there's activity

---

## `c2s_public.packages`

One row per shipping package. Join: `item_metrics.package_id = packages.id`

| column | type | notes |
|---|---|---|
| id | INT64 | Primary key — matches `item_metrics.package_id` |
| status | STRING | `Delivery`, `In Transit`, `Exception`, NULL |
| accrual_cost | STRING | **CAST to FLOAT64** — estimated shipping cost |
| billed_cost | STRING | **CAST to FLOAT64** — actual carrier cost |
| packed_at | TIMESTAMP | When packed |
| delivered_at | TIMESTAMP | When delivered |
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

**Inventory + sales don't join on date** — aggregate each separately, then join on `item_id`.

## `category_path` parsing

`RTIC > Drinkware > Tumblers > Road Trip Tumbler` — use `SPLIT(category_path, ' > ')`:
- `[SAFE_OFFSET(0)]` → brand
- `[SAFE_OFFSET(1)]` → department
- `[SAFE_OFFSET(2)]` → sub-department

Or use `analytics.items.category1/2/3` or `planning_group_category`.

## Key Business Rules

- **D2C channels:** `order_sales_channel IN ('Web', 'Amazon')`
- **New customers:** `order_number = 1`
- **Active items:** `lifecycle_status IN ('Active / evergreen', 'Active / seasonal')`
- **Warehouse inventory:** `location_type IN ('warehouse', 'customization')`
- **Current inventory:** `WHERE date = CURRENT_DATE('America/Los_Angeles')`
- **Buffer = available_units - safety_stock** (negative = below safety stock)
- **Weeks of supply = available_units / avg_weekly_demand**
