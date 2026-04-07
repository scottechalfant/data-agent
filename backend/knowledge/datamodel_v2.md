# BQ Inventory Metrics

## BigQuery Project

- **Project:** `velky-brands`
- **Auth:** Application Default Credentials at `~/.config/gcloud/application_default_credentials.json`
- **Notebook magic:** `%%bigquery` via `bigquery_magics` extension
- **Timezone note:** The business operates in Central Time (America/Chicago). All TIMESTAMP columns in `analytics.item_metrics` (`order_date`, `fulfillment_date`, `delivery_date`, etc.) are stored in **Central Time** — use `TIME(CURRENT_DATETIME('America/Chicago'))` for time-of-day comparisons. `CAST(order_date AS DATE)` is already in CT with no conversion needed.
- **Current date:** 2026-04-07

---

## Tables Overview

| Table | What it is |
|---|---|
| `inventory.inventory_daily` | Daily snapshot of units on hand and value, per SKU per location |
| `analytics.item_metrics` | One row per order line item — the primary sales/P&L fact table |
| `analytics.items` | Item dimension table — attributes, lifecycle, costs, categories |
| `replen.demand_forecast_items_latest` | Weekly demand forecast per item (D2C + B2B), future-looking |
| `replen.po_status` | Purchase order / forecast status with units ordered, received, OTW |
| `operations.receipts` | Actual inventory receipts by container, item, and location |
| `c2s_public.itempacking` | Physical dimensions, weight, and fulfillment attributes per item × UOM |
| `c2s_public.uom` | Unit of measure lookup — each (uom_id=1) and case pack definitions |
| `analytics.return_metrics` | One row per order × item × return — full return lifecycle with financials, disposition, and reasons |
| `c2s_public.packages` | One row per physical shipping package — tracking, dimensions, shipping costs (accrual and billed), delivery status |
| `marketing.ga4_sessions` | One row per GA4 web session — traffic source, device, funnel flags, page path array, cart contents, A/B test assignments, and attributed revenue |
| `inventory.item_sell_through` | One row per item — current available units, units on order, daily demand rate, and days/weeks to sell through |
| `inventory.inventory_metrics_item_daily` | One row per item × date — daily inventory position, sales velocity, aging, forecast demand, and YoY comparisons |
| `marketing.marketing_metrics` | One row per date × marketing dimension — blends sales, sessions, and ad spend for channel-level reporting |
| `retail.daily` | One row per date × retailer location × item — daily POS sales, returns, and on-hand inventory from Walmart, Target, Lowe's, and West Marine via Alloy data feed |

---

## Table Details

### `inventory.inventory_daily`

**What it is:** A daily snapshot view (one row per SKU x location x date) of inventory levels, values, and costs. This is a VIEW built on top of `c2s_stats.inventory`, `c2s_public.item_locations`, `analytics.items`, `c2s_public.locations`, and `c2s_public.websiteitems`. Data goes back to 2016-12-06. As of 2026-04-06, the most recent snapshot date is 2026-04-06. Total row count is ~10.8M.

**Key gotcha:** `sku` and `item_id` are identical — the view aliases `sku` as `item_id`. Both columns have the same value. Use `sku` or `item_id` interchangeably, but join to other tables on `item_id`.

| column | type | notes |
|---|---|---|
| date | DATE | Daily snapshot date — filter to `current_date()` or a specific date for point-in-time inventory |
| location_id | INT64 | Numeric location key (2, 8, 13, 14, 16, 17, 20, 22, 25) |
| location_name | STRING | Human-readable location name |
| location_type | STRING | `warehouse`, `retail`, `amazon`, `customization`, `3pl` |
| business | STRING | `RTIC` or `Cuero` |
| category_path | STRING | `>` delimited hierarchy, e.g. `RTIC > Drinkware > Bottles > Water Bottles` |
| parent_product | STRING | Product family name, e.g. `20 QT Ultra-Tough Cooler` |
| title | STRING | Full SKU title including color/size/variant |
| sku | INT64 | SKU identifier — **same value as item_id** |
| item_id | INT64 | Item identifier — **same value as sku** (aliased in the view) |
| page_title | STRING | Marketing page title; often NULL (~32% of rows) |
| type | STRING | Product type, e.g. `Compact Hard Sided Cooler` |
| vendor_name | STRING | Supplier/manufacturer name |
| total_units | FLOAT64 | Total units on hand (on_hand - picked - committed) |
| avaliable_units | FLOAT64 | **TYPO — do not use.** Misspelled duplicate of available_units |
| available_units | FLOAT64 | Units available — use this column, not `avaliable_units` |
| total_value | FLOAT64 | Total inventory value = material_costs + (transportation_avg × total_units) |
| avg_unit_value | FLOAT64 | Average cost per unit = total_value / total_units |
| material_costs | FLOAT64 | Material cost component of total_value |
| safety_stock | FLOAT64 | Target safety stock level; NULL for ~38% of rows (open box / clearance items) |

**Categorical values for `location_type`:**

| value | row count | pct |
|---|---|---|
| warehouse | ~7.6M | 70.9% |
| retail | ~2.8M | 25.8% |
| amazon | ~144K | 1.3% |
| customization | ~122K | 1.1% |
| 3pl | ~86K | 0.8% |

**Known locations (`location_name`):**

| location_name | location_type | location_id |
|---|---|---|
| Katy HQ | warehouse | 20 |
| Gateway | warehouse | 8 |
| Hempstead | warehouse | 2 |
| Remote Container Storage, Houston | warehouse | 14 |
| Retail, Houston | retail | 13 |
| Amazon Warehouse (FBA) | amazon | 22 |
| Telge (Customization) | customization | 16 |
| Hempstead Customization | customization | 17 |
| RJW | 3pl | 25 |

**Categorical values for `business`:** `RTIC` (~76.3%), `Cuero` (~23.7%)

**Notes:**
- `avaliable_units` is a known typo in the underlying view — **always use `available_units`**
- `safety_stock` is NULL for open box / clearance items (~38% of today's rows)
- `total_value` includes both material cost and transportation/freight allocation
- The view deduplicates with an AVG aggregate per (date, location, sku) — no duplicates expected
- For current inventory, always filter: `WHERE date = CURRENT_DATE('America/Los_Angeles')`
- To get warehouse-only totals (standard replenishment view), filter: `WHERE location_type IN ('warehouse', 'customization')`
- **`HAVING SUM(...) > 0` does not work on this view** — the view uses internal aggregation, so BigQuery rejects further `HAVING` aggregation. Wrap in a subquery and use `WHERE` instead:
  ```sql
  SELECT item_id, available_units FROM (
    SELECT item_id, SUM(available_units) AS available_units
    FROM inventory.inventory_daily WHERE ...
    GROUP BY item_id
  ) WHERE available_units > 0
  ```
- As of 2026-04-06, only 7 of the 9 historical locations have current-day data. Telge (Customization) and Hempstead Customization do not appear in today's snapshot, though they exist in historical data.
- The largest inventory concentrations by value are at Katy HQ (~$19.8M) and Gateway (~$18.8M).



---

### `analytics.item_metrics`

**What it is:** The primary sales and P&L fact table. One row per order line item (order × item). Built from orders, shipments, costs, and marketing attribution. Refreshed every 15 minutes from a scheduled query. Contains data from approximately 2019 onward. This is a very wide table with ~100+ columns.

**Granularity:** One row = one order line item (one item on one order). A single order will have multiple rows if it contains multiple items.

| column | type | notes |
|---|---|---|
| order_id | INT64 | Order identifier; join to `c2s_public.orders` |
| orderitem_id | INT64 | Order item identifier (unique row key) |
| package_id | INT64 | Shipment package identifier |
| shipment_service | STRING | Carrier service code (see categorical values below) |
| item_id | INT64 | Item identifier; join key to `analytics.items` and inventory tables |
| title | STRING | Full SKU title |
| discountAmount | STRING | Discount amount applied (stored as STRING — cast to FLOAT64 if aggregating) |
| category_id | INT64 | Category identifier |
| is_inactive | BOOL | Whether item is inactive |
| type | STRING | Product type |
| category_path | STRING | Category hierarchy |
| size | STRING | Item size |
| color | STRING | Item color |
| name | STRING | Item name |
| item_parent | STRING | Parent product name |
| item_pgc | STRING | Planning group category |
| item_pgn | STRING | Planning group name |
| customer_id | INT64 | Customer identifier |
| customer_id_type | STRING | Customer ID type |
| household_id | INT64 | Household identifier |
| order_date | TIMESTAMP | When the order was placed (UTC) |
| order_type | STRING | Order type |
| order_channel | STRING | Order channel |
| order_status | STRING | Order status |
| location_name | STRING | Fulfillment location name |
| order_utm_source | STRING | UTM source |
| order_utm_medium | STRING | UTM medium |
| order_utm_campaign | STRING | UTM campaign |
| order_external_id | STRING | External order ID |
| order_division | STRING | Division name (e.g. `RTIC D2C`, `RTIC B2B`) |
| order_sales_channel | STRING | `Web`, `Amazon`, `Bulk`, `Retail`, `Customization`, `Wholesale` |
| c2s_sales_channel | STRING | Internal sales channel |
| order_new_sales_channel | STRING | Standardized new sales channel |
| order_sub_sales_channel | STRING | Sub-channel (e.g. `Web Bulk`) |
| order_sales_channel_group | STRING | `D2C` or `Wholesale` |
| order_ship_state | STRING | Shipping state |
| order_ship_zone | INT64 | Shipping zone (1–8) |
| order_ship_zip | STRING | Shipping zip code |
| order_bill_state | STRING | Billing state |
| order_bill_zip | STRING | Billing zip code |
| order_number | INT64 | Customer order number (1 = first order from that customer) |
| order_number_household | INT64 | Order number within household |
| shipWindowStart | DATE | Ship window start |
| shipWindowEnd | DATE | Ship window end |
| order_marketing_platform | STRING | Marketing platform |
| order_marketing_media_type | STRING | Media type |
| order_marketing_channel | STRING | Marketing channel (e.g. `Email`, `Paid Search`, `FB & IG Paid`) |
| order_marketing_campaign | STRING | Marketing campaign name |
| order_marketing_campaign_group | STRING | Campaign group |
| order_marketing_campaign_type | STRING | Campaign type |
| order_marketing_branded | STRING | Whether branded search |
| order_business | STRING | `RTIC`, `Cuero`, `BottleKeeper` |
| order_promo_codes | STRING | Applied promo codes |
| order_payment_type | STRING | Payment type (stripe, affirm, square) |
| idme_groups | STRING | ID.me groups (e.g. `military`, `responder`) |
| orderitem_created | TIMESTAMP | When order item was created |
| fulfillment_status | STRING | Fulfillment status |
| uom | STRING | Unit of measure name |
| uom_conversion | FLOAT64 | UOM conversion factor |
| base_rate | FLOAT64 | Base price per unit |
| uom_rate | FLOAT64 | Price per UOM |
| original_uom_rate | FLOAT64 | Original price before discounts |
| first_invoice_date | TIMESTAMP | First invoice date |
| item_duties_avg_per_unit | FLOAT64 | Estimated duties per unit |
| item_fees_avg_per_unit | FLOAT64 | Estimated fees per unit |
| fulfillment_date | TIMESTAMP | When order was fulfilled/shipped (UTC) |
| base_quantity | FLOAT64 | Quantity in base units — **use this for unit counts** |
| uom_quantity | FLOAT64 | Quantity in UOM units |
| delivery_date | TIMESTAMP | Estimated/actual delivery date |
| shipping_paid | FLOAT64 | Shipping revenue collected from customer |
| gross_sales | FLOAT64 | Gross sales before discounts |
| material_cost | FLOAT64 | Material cost for this line item |
| amazon_fees | FLOAT64 | Amazon marketplace fees (hard-coded to ~15% for Amazon orders) |
| square_fees | FLOAT64 | Square payment processing fees |
| credits | FLOAT64 | Credits applied |
| uom_id | INT64 | UOM identifier |
| full_price | FLOAT64 | Full (list) price |
| bundle_type | STRING | Bundle type if item is part of a bundle |
| bundle_id | INT64 | Bundle identifier |
| bundle_name | STRING | Bundle name |
| bundle_category_path | STRING | Bundle category path |
| bundle_quantity | FLOAT64 | Quantity within bundle |
| upsell_base_item_id | INT64 | Base item ID for upsell items |
| is_asi_member | BOOL | Whether customer is ASI member |
| myRTIC | BOOL | Whether this is a myRTIC customization order |
| design_id | INT64 | myRTIC design ID |
| myRTIC_fees | STRUCT | Nested struct of myRTIC fee components (total, face_fees, upload_fees, color_fees, etc.) — populated on the BASE item row only; the same fees also appear as separate fee line items in the order |
| myRTIC_job_completed | BOOL | myRTIC job completion status |
| myRTIC_job_completed_at | TIMESTAMP | myRTIC job completion timestamp |
| myRTIC_failure_count | INT64 | myRTIC job failure count |
| myRTIC_design_approved | BOOL | myRTIC design approval status |
| myRTIC_design_approved_at | TIMESTAMP | myRTIC design approval timestamp |
| myRTIC_graphic_type | STRING | myRTIC graphic type |
| shipping_cost | FLOAT64 | Actual or estimated outbound shipping cost |
| shipping_cost_source | STRING | How shipping cost was determined |
| unfulfilled_shipping_estimate | FLOAT64 | Estimated shipping cost for unfulfilled orders |
| product_sales | FLOAT64 | Product revenue (gross_sales - discounts) |
| total_cost | FLOAT64 | Total cost (material + shipping + duties + fees) |
| selling_cost | FLOAT64 | Selling cost component |
| fulfillment_date_pl | TIMESTAMP | Fulfillment date for P&L purposes |
| gross_margin | FLOAT64 | Gross margin = product_sales - material_cost - amazon_fees - square_fees |
| net_margin | FLOAT64 | Net margin = gross_margin - shipping_cost - duties - other fees |
| sales | FLOAT64 | **Primary revenue metric** = product_sales + shipping_paid + credits |
| item_commission | FLOAT64 | Commission expense |
| item_commission_group | STRING | Commission group |
| customization_graphic_type | STRING | Customization graphic type |

**Key financial metrics:**
- `sales` = total revenue (product + shipping collected)
- `product_sales` = product revenue only (no shipping)
- `gross_margin` = sales minus material cost and marketplace fees
- `net_margin` = gross_margin minus shipping cost and all other direct costs
- `base_quantity` = units sold in base units (always use this for unit counts)

**Categorical values for `shipment_service`** (top values):
`GROUND_HOME_DELIVERY`, `SMART_POST`, `UPS_GROUND`, `UPS_SUREPOST`, `FEDEX_GROUND`, `retail`, `FEDEX_2_DAY`, `GroundBasic`, `PRCLSEL`, `USPS_PRIORITY_MAIL`, `AMZN_US`, `WILL_CALL`

**Categorical values for `type`** (top values):
`Tumblers`, `Soft Pack Cooler`, `Bottle`, `Travel Mug`, `Jug`, `Day Cooler`, `Water Bottle`, `BottleKeeper`, `Lightweight Backpack Cooler`, `65 QT Hard Sided Cooler`, `Ice Packs`, `Essential Tumbler`, `Road Trip Tumbler`

**Notes:**
- `order_date` is a TIMESTAMP in UTC — cast to DATE for daily aggregations: `CAST(order_date AS DATE)`
- `discountAmount` is stored as STRING — must be `CAST(discountAmount AS FLOAT64)` to aggregate
- For standard D2C web sales: `WHERE order_sales_channel IN ('Web', 'Amazon')`
- For new customer analysis: `WHERE order_number = 1`
- The `myRTIC_fees` STRUCT fields must be accessed with dot notation: `myRTIC_fees.total`
- **myRTIC fee representation:** myRTIC fees appear TWICE — as a STRUCT on the base item row (`myRTIC_fees.total`) AND as separate fee line items in the same order. Do not sum both — pick one. Use `myRTIC_fees.total` on base item rows for per-item fee analysis, or filter to fee line items for order-level fee revenue. Never add them together.
- **Custom Shop (Customization channel) fees:** Only represented as separate fee line items — there is NO struct equivalent on the base item. These are ASI/B2B decoration orders, not myRTIC consumer customization.
- Table is very large (~30M+ rows); always filter by date range. Use `order_date > '2024-01-01'` or similar
- `fulfillment_date` can be NULL for unfulfilled orders
- Exclude test/internal customers with known customer_id filters when needed
- When aggregating units sold by product, exclude non-product line items using these `item_parent` filters:
  ```sql
  AND item_parent NOT LIKE '%Fee%'           -- customization fees (e.g. MyRTIC Customization Fee)
  AND item_parent NOT LIKE '%Replacement%'   -- replacement parts
  AND item_parent NOT LIKE '%Gasket%'        -- gaskets
  AND item_parent NOT LIKE '%Drain Plug%'    -- drain plugs
  AND item_parent NOT LIKE '% Feet'          -- cooler feet
  AND item_parent NOT LIKE '%Lid%'           -- standalone lids
  ```
  Accessories (ice packs, duffle bags, straps, baskets) are intentionally kept — only fees and replacement/repair parts are excluded.

---

---

### `analytics.items`

**What it is:** The item dimension/master table. One row per item (SKU). Contains all item attributes, lifecycle status, cost averages, category hierarchy, vendor info, and planning metadata. Approximately 7,500 items total across all businesses and channels.

| column | type | notes |
|---|---|---|
| id | INT64 | **Primary key** — this is the `item_id` used to join all other tables |
| title | STRING | Full item title including variant |
| old_parentName | STRING | Legacy parent name |
| old_variantName | STRING | Legacy variant name |
| category_id | INT64 | Category identifier |
| is_inactive | BOOL | Whether item is inactive/discontinued |
| type | STRING | Product type — maps to a specific product line (e.g. `Road Trip Tumbler`, `Journey Bottle`). All SKUs of the same type share a product page on the D2C website, with color/size as selectors. Generally all SKUs of a given type+size share the same retail price, though special colors/prints/finishes may differ. |
| channel | STRING | Sales channel: `rtic`, `cuero`, `bk` (BottleKeeper), `ccmb`, `beds` |
| size | STRING | Size descriptor |
| size_numeric | FLOAT64 | Numeric size value |
| color | STRING | Color name |
| name | STRING | Short item name |
| material | STRING | Material finish: `Matte`, `Soft Touch`, `Suede`, `Multi`, or NULL |
| duties_avg | FLOAT64 | Average duty cost per unit |
| fees_avg | FLOAT64 | Average fees per unit |
| transportation_avg | FLOAT64 | Average transportation/freight cost per unit |
| materials_avg | FLOAT64 | Average material cost per unit |
| item_costs_updated | TIMESTAMP | When cost averages were last updated |
| is_customization_fee | BOOL | Whether this is a customization fee line item |
| visible_on_rticweb | BOOL | Visible on RTIC website |
| visible_on_web | BOOL | Visible on any web storefront |
| case_visible_on_rticweb | BOOL | Case pack visible on RTIC website |
| case_visible_on_web | BOOL | Case pack visible on web |
| lifecycle_status | STRING | Current lifecycle status (see values below) |
| lifecycle_start | DATE | Start date of current lifecycle stage |
| lifecycle_end | DATE | End date of current lifecycle stage |
| vendor_id | INT64 | Vendor identifier |
| vendor_name | STRING | Vendor/manufacturer name |
| item_type | STRING | NetSuite item type: `InvtPart`, `Assembly`, etc. |
| current_duty_rate | FLOAT64 | Current duty rate as decimal |
| default_source_port | STRING | Default origin port |
| most_recent_po_cost | FLOAT64 | Most recent PO cost |
| category_path | STRING | Full `>` delimited category path |
| parentName | STRING | Parent product family name (e.g. `30oz Road Trip Tumbler`) |
| variantName | STRING | Variant name (e.g. `30oz Road Trip Tumbler, Black`) |
| business | STRING | `RTIC`, `Cuero`, `BottleKeeper` |
| upp | BOOL | UPP (Unilateral Pricing Policy) flag |
| pallet_quantity | INT64 | Units per pallet |
| case_quantity | INT64 | Units per case |
| single_ship | BOOL | Whether item ships individually (vs. in case) |
| planning_group_category | STRING | Planning group category (e.g. `Hard Coolers`, `Drinkware`, `Soft Coolers`) |
| planning_group_name | STRING | Planning group name |
| budget_category | STRING | Budget category |
| category1 | STRING | Category level 1 |
| category2 | STRING | Category level 2 |
| category3 | STRING | Category level 3 |
| bin_RTIC_partial_pallet | INT64 | Bin count at RTIC partial pallet location |
| bin_RTIC_drinkware | INT64 | Bin count at RTIC drinkware location |
| bin_Cuero | INT64 | Bin count at Cuero location |
| bin_Bottlekeeper | INT64 | Bin count at BottleKeeper location |
| bins | STRING | Bin assignments |
| each_comp_price | STRING | Each comparable price |
| each_price | STRING | Each unit price |
| each_upc | STRING | Each unit UPC barcode |
| case_price | STRING | Case price |
| case_upc | STRING | Case UPC barcode |
| case_uom_id | INT64 | Case UOM identifier |
| container_quantity | FLOAT64 | Units per container (for replenishment) |
| image_url | STRING | Item image URL |
| approx_create_date | DATE | Approximate date the item was created — derived from `analytics.item_created` view. For items with a purchase order, this is `MIN(po_forecasts.created) - 30 days`; for items without a PO, it is linearly interpolated between neighboring item_ids that do have PO anchors (item_ids are assigned sequentially). Excludes fee and open box items. 6,592 items covered, 0 nulls. |
| myrtic_category | STRING | myRTIC customization category |
| myrtic_graphic_type | STRING | myRTIC graphic type |
| myrtic_color_method | STRING | myRTIC color method |
| myrtic_type | STRING | myRTIC type |

**Categorical values for `lifecycle_status`:**

| value | count |
|---|---|
| NULL | 2,309 |
| Pre-Sale / setup | 2,217 |
| Post-Sale / retired | 1,473 | After end date **and out of stock** — final state after discontinued |
| Post-Sale / discontinued | 588 | After end date but **still in stock** — transitions to retired once stock is depleted |
| Active / evergreen | 382 |
| Active / seasonal | 197 |
| Pre-Sale / new | 152 |
| Pre-Sale / new-onorder-disco | 126 |
| Pre-Sale / new-on-order | 35 |

**Categorical values for `channel`:** `rtic` (5,345), `cuero` (1,505), `bk` (452), `ccmb` (169), `beds` (5)

**Categorical values for `material`:** `Matte` (246), `Multi` (19), `Soft Touch` (12), `Suede` (3); mostly NULL

**Notes:**
- `id` is the universal item key — it equals `item_id` in all other tables
- `parentName` is the product family (e.g. "30oz Road Trip Tumbler") — use this for product-level aggregation
- `variantName` is only the color/variant appended to the parent name — it is NOT the full readable SKU title
- `title` is the full readable SKU title (e.g. "32 QT Ultra-Light Cooler, Dark Grey & Cool Grey") — **always use `title` when displaying a specific SKU to a user**, not `variantName`
- `is_inactive` is a **legacy soft-delete flag** — do NOT use it to determine whether an item is "active". Use `lifecycle_status` instead.
- **Active items** = `WHERE lifecycle_status IN ('Active / evergreen', 'Active / seasonal')`
- Active lifecycle statuses: `Active / evergreen`, `Active / seasonal`
- `planning_group_category` is the best field for broad category grouping in operations/replenishment context

---

---

### `replen.demand_forecast_items_latest`

**What it is:** A VIEW that shows the current weekly demand forecast per item. One row per item × forecast week. The forecast is split into D2C (direct-to-consumer) and B2B (bulk/wholesale) unit forecasts. The view is built by joining `replen.demand_forecast_latest` (parent-level forecast by `forecast_unit`) with `replen.demand_forecast_allocation_latest` (which allocates parent forecasts down to individual items). Future weeks (from the most recent `created` date through 2030) are included.

| column | type | notes |
|---|---|---|
| date | TIMESTAMP | Start of the forecast week (weekly, truncated to Sunday) |
| forecast_unit | STRING | Parent forecast unit identifier (e.g. `30oz_Road_Trip_Tumbler`) |
| category1 | STRING | Category level 1 (e.g. `Tumblers`, `Bottles`, `Ultralight Hard Coolers`) |
| category2 | STRING | Category level 2 (e.g. `Drinkware`, `Hard Coolers`, `Soft Coolers`) |
| child_forecast_unit | STRING | Child forecast unit with item_id (e.g. `30oz_Road_Trip_Tumbler_Black_20696`) |
| item_id | INT64 | Item identifier — join key to `analytics.items` and `inventory.inventory_daily` |
| d2c_units | FLOAT64 | Forecasted D2C units for this item for this week |
| b2b_units | FLOAT64 | Forecasted B2B/bulk units for this item for this week |
| created | TIMESTAMP | When this forecast version was created |

**Categorical values for `category1`** (top values):
`Tumblers`, `Bottles`, `Ultralight Hard Coolers`, `Mugs`, `Day Pack Coolers`, `Can Insulators & Chillers`, `Soft Pack Coolers`, `Original Hard Coolers`, `Jugs`, `Duffles and Backpacks`

**Categorical values for `category2`:** `Drinkware`, `Hard Coolers`, `Soft Coolers`, `Other`

**Notes:**
- Filter to future weeks only: `WHERE date > CURRENT_TIMESTAMP()`
- The table includes both past actual weeks (for backtesting) and future forecast weeks
- `d2c_units` and `b2b_units` can be NULL — always use `COALESCE(d2c_units, 0) + COALESCE(b2b_units, 0)` when summing
- `d2c_units + b2b_units` = total forecasted demand for the week
- The forecast is weekly — each week starts on Sunday
- `created` tells you the age/version of the forecast; most recent created date = current forecast
- `forecast_unit` names are underscore-separated, e.g. `40oz_Road_Trip_Tumbler`
- `child_forecast_unit` encodes both the variant and item_id: `<variant>_<item_id>`

---

---

### `inventory.inventory_metrics_item_daily`

**What it is:** A comprehensive daily inventory analytics VIEW. One row per item × date. Joins `inventory.inventory_daily` (warehouse locations only), `operations.receipts`, `analytics.item_metrics` (sales), `inventory.item_sell_through` (units on order), `replen.po_status` (PO arrival dates), `replen.demand_forecast_items_latest` (demand forecast), and `analytics.items` (item attributes) to produce a unified daily picture of each SKU's inventory position, sales velocity, aging, forecast demand, and year-over-year comparisons. Excludes items with "WHOLESALE" in the title. Data goes back to 2016-12-06. As of 2026-04-06, the most recent date is 2026-04-06. ~5.8M rows total, ~2,092 items on the current date.

**Granularity:** One row = one item × one date. Every date that an item appears in `inventory.inventory_daily` (warehouse locations) produces a row, regardless of whether the item had sales or receipts that day.

**Source scope:** Inventory is aggregated from `location_type = 'warehouse'` only (not customization, retail, amazon, or 3pl). Sales come from all channels in `analytics.item_metrics` (not filtered by channel).

| column | type | notes |
|---|---|---|
| `date` | DATE | Daily snapshot date |
| `item_id` | INT64 | Item identifier — join key to `analytics.items.id` and all other tables |
| `title` | STRING | Full SKU title from `analytics.items` |
| `parent` | STRING | Parent product name (`analytics.items.parentName`) |
| `type` | STRING | Product type (e.g. `Tumblers`, `Soft Pack Cooler`) |
| `pgc` | STRING | Planning group category (`analytics.items.planning_group_category`) |
| `pgn` | STRING | Planning group name |
| `category_path` | STRING | Full `>` delimited category hierarchy |
| `pallet_quantity` | INT64 | Units per pallet from `analytics.items` — used to compute `pallets_on_hand` |
| `lifecycle_status` | STRING | **Point-in-time lifecycle status** — computed by the view based on lifecycle dates, inventory levels, PO status, and `is_inactive` flag (see logic below) |
| `lifecycle_start` | DATE | Lifecycle start date from `analytics.items` |
| `lifecycle_end` | DATE | Lifecycle end date from `analytics.items` |
| `beginning_inventory` | FLOAT64 | Previous day's `ending_inventory` (via LAG); NULL on the first day an item appears |
| `units_received` | INT64 | Units received at warehouse on this date, from `operations.receipts`; 0 if no receipts |
| `units_sold` | FLOAT64 | Units sold on this date, from `analytics.item_metrics` (`SUM(base_quantity)`); 0 if no sales |
| `sales_dollars` | FLOAT64 | Sales revenue on this date, from `analytics.item_metrics` (`SUM(sales)`); 0 if no sales |
| `ending_inventory` | FLOAT64 | Available units at end of day = `SUM(available_units)` from `inventory.inventory_daily` for warehouse locations |
| `inventory_adjustment` | FLOAT64 | Implied adjustment = `ending_inventory - beginning_inventory - units_received + units_sold`. Captures shrinkage, write-offs, transfers, and data corrections. NULL when `beginning_inventory` is NULL (first day). Non-zero values indicate unexplained inventory changes. |
| `material_value` | FLOAT64 | Total material cost of inventory on hand, from `inventory.inventory_daily` (`SUM(material_costs)`) |
| `pallets_on_hand` | FLOAT64 | `ending_inventory / pallet_quantity`, rounded to 2 decimals; NULL if `pallet_quantity` is 0 or NULL |
| `safety_stock` | FLOAT64 | Safety stock level from `inventory.inventory_daily` (`MAX(safety_stock)`); NULL for open box / clearance items |
| `is_instock` | INT64 | 1 if `ending_inventory > 1.1 × IFNULL(safety_stock, 0)`, else 0. An item is "in stock" when it has more than 110% of safety stock (or any inventory if no safety stock is defined). |
| `units_on_order` | INT64 | Total units on open POs not yet received (`remaining_units + otw_units`), from `inventory.item_sell_through`; 0 if none. **Not date-varying** — same value for all dates (current snapshot). |
| `next_arrival_date` | DATE | Earliest expected arrival date for open POs. Uses `MIN(first_otw_delivery_date)` if OTW containers exist; otherwise estimates as `MIN(ship_date) + 60 days` for POs with a ship date within the last 75 days. NULL if no open POs. **Not date-varying.** |
| `oldest_inventory_age_days` | INT64 | Age in days of the oldest receipt batch still on hand (FIFO); NULL if no receipt history or zero inventory |
| `avg_inventory_age_days` | FLOAT64 | Weighted-average age of on-hand inventory in days (FIFO); NULL if no receipt history or zero inventory |
| `units_sold_90d` | FLOAT64 | Rolling 90-day sum of `units_sold` (trailing window: 89 preceding rows + current row) |
| `sales_dollars_90d` | FLOAT64 | Rolling 90-day sum of `sales_dollars` |
| `daily_demand_rate` | FLOAT64 | `units_sold_90d / 90.0` — average daily sales rate over the trailing 90 days; 0 if no sales (never NULL) |
| `weeks_to_sell_through` | FLOAT64 | `ending_inventory / daily_demand_rate / 7.0` — weeks of supply based on trailing sales velocity; NULL if `daily_demand_rate = 0` |
| `dio_days` | FLOAT64 | Days Inventory Outstanding = `ending_inventory / daily_demand_rate` — days of supply; NULL if `daily_demand_rate = 0` |
| `inventory_turns` | FLOAT64 | Annualized inventory turns = `(daily_demand_rate × 365) / ending_inventory`; NULL if `ending_inventory = 0` |
| `forecast_units_30d` | FLOAT64 | Forecasted total demand (D2C + B2B) over next 30 days, pro-rated for partial weeks; NULL if no forecast exists |
| `forecast_units_60d` | FLOAT64 | Forecasted total demand over next 60 days |
| `forecast_units_90d` | FLOAT64 | Forecasted total demand over next 90 days |
| `forecast_units_180d` | FLOAT64 | Forecasted total demand over next 180 days |
| `forecast_units_270d` | FLOAT64 | Forecasted total demand over next 270 days |
| `forecast_units_365d` | FLOAT64 | Forecasted total demand over next 365 days |
| `prev90_unitsLY` | FLOAT64 | Units sold in the 90-day trailing window one year ago (LY). For date `d`, sums daily sales from `[d − 1yr − 89d, d − 1yr]`. NULL if no LY sales data exists for that item + date. |
| `prev90_salesLY` | FLOAT64 | Sales dollars in the 90-day trailing window one year ago (LY) |
| `next90_unitsLY` | FLOAT64 | Units sold in the 90-day forward window one year ago (LY). For date `d`, sums daily sales from `[d − 1yr, d − 1yr + 89d]`. Useful for comparing current trailing velocity to the trajectory LY was on. NULL if no LY data. |
| `next90_salesLY` | FLOAT64 | Sales dollars in the 90-day forward window one year ago (LY) |

**Categorical values for `lifecycle_status`:**

This view computes a **point-in-time lifecycle status** that differs from the static `analytics.items.lifecycle_status`. The logic is evaluated as a CASE expression in this priority order:

| value | condition | count (current) | inventory held |
|---|---|---|---|
| `Pre-Sale / setup` | `is_inactive = FALSE`, no lifecycle dates set (both NULL) | 598 | 404K |
| `Post-Sale / retired` | `is_inactive = TRUE`, OR lifecycle ended with `ending_inventory < 55` | 354 | 3K |
| `Post-Sale / discontinued` | Lifecycle ended, `ending_inventory >= 55`, not retired | 350 | 661K |
| `Active / evergreen` | `lifecycle_start <= date` and `lifecycle_end IS NULL` (no planned end) | 321 | 1.58M |
| `Pre-Sale / new` | No PO history found in `replen.po_status` (post-2022) | 307 | 411K |
| `Active / seasonal` | Within lifecycle window (`start <= date <= end`), OR has units on order with no lifecycle_start | 159 | 352K |
| `Pre-Sale / new-on-order` | Zero inventory, units on order, within lifecycle window | ~3 | 0 |
| `Pre-Sale / new-onorder-disco` | Zero inventory, units on order, outside lifecycle window | ~3 | 0 |

**Lifecycle status logic detail (CASE order):**
1. `is_inactive = TRUE` → `Post-Sale / retired`
2. Both `lifecycle_start` and `lifecycle_end` are NULL → `Pre-Sale / setup`
3. `lifecycle_start <= date` and `lifecycle_end IS NULL` → `Active / evergreen`
4. No PO history (item never appears in `replen.po_status` after 2022-06-01) → `Pre-Sale / new`
5. Zero inventory + units on order + outside lifecycle window → `Pre-Sale / new-onorder-disco`
6. Zero inventory + units on order → `Pre-Sale / new-on-order`
7. Within lifecycle window (start/end bounds, NULLs treated as open-ended) → `Active / seasonal`
8. No lifecycle_start + units on order → `Active / seasonal`
9. `ending_inventory < 55` → `Post-Sale / retired`
10. All else → `Post-Sale / discontinued`

**Key computed metrics:**

- **Inventory adjustment:** `ending_inventory - beginning_inventory - units_received + units_sold`. This is the unexplained change in inventory — captures shrinkage, write-offs, inter-warehouse transfers, manual corrections, and data timing mismatches. Should be 0 in a perfect system; persistent non-zero values indicate operational issues.

- **FIFO inventory age:** The view builds a cumulative receipts ledger (`receipts_fifo`) by item, ordered by receipt date. For each day, it identifies which receipt batches are still "on hand" by comparing cumulative receipts against cumulative units consumed (received minus current ending inventory). `avg_inventory_age_days` is the weighted average age across all on-hand receipt batches. `oldest_inventory_age_days` is the age of the earliest receipt batch still contributing to on-hand stock. Both are NULL when `ending_inventory = 0` or when cumulative receipts are insufficient to explain on-hand stock (items predating receipt tracking).

- **Rolling 90-day sales metrics:** `units_sold_90d`, `sales_dollars_90d`, and `daily_demand_rate` use a SQL window of `ROWS BETWEEN 89 PRECEDING AND CURRENT ROW`. This is a **row-based** window, not a calendar-based window — if an item has gaps in its daily inventory history (rare but possible), the window may span more than 90 calendar days. In practice, inventory snapshots are daily and continuous, so this equals 90 calendar days.

- **Sell-through / DIO / Turns:** All derived from `daily_demand_rate` (trailing 90-day sales-based).
  - `weeks_to_sell_through` = `dio_days / 7`
  - `dio_days` = `ending_inventory / daily_demand_rate`
  - `inventory_turns` = `daily_demand_rate × 365 / ending_inventory`
  - All are NULL when the denominator is 0 (no sales or no inventory, respectively).

- **Forecast horizon columns:** The 30/60/90/180/270/365-day forecast columns sum forecasted demand from `replen.demand_forecast_items_latest` with **pro-rating for partial weeks**. Since forecasts are weekly, the view computes what fraction of each week's forecast falls within the horizon window and scales accordingly. All forecast columns are **not date-varying** — they reflect the current forecast as of today, not the forecast that existed on the historical date.

- **LY comparison columns:** `prev90_unitsLY` / `prev90_salesLY` show the 90-day trailing sales window from one year ago. `next90_unitsLY` / `next90_salesLY` show the 90-day forward window from one year ago. These are computed on actual LY daily sales dates using row-based windows, then joined with a 1-year offset. They are NULL when no LY sales data exists for the item + offset date (e.g., new items launched this year, or items with no sales on the corresponding LY date).

**Current-day summary (2026-04-06):**

| metric | value |
|---|---|
| Total items | 2,092 |
| Items with inventory > 0 | 1,690 |
| Items in-stock (`is_instock = 1`) | 1,330 |
| Total ending inventory (units) | 3.41M |
| Total material value | $28.3M |
| Total pallets on hand | 22,842 |
| Items with units on order | 429 |
| Median DIO (items with sales) | 290 days |
| Median weeks to sell through | 41 weeks |
| Median avg inventory age | 300 days |

**NULL rates (current date, 2,092 items):**

| column | NULL count | % NULL | why |
|---|---|---|---|
| `beginning_inventory` | 0 | 0% | Only NULL on first-ever date for an item |
| `avg_inventory_age_days` | 705 | 34% | Zero inventory or no receipt history |
| `daily_demand_rate` | 0 | 0% | Always computed (0 if no sales) |
| `forecast_units_90d` | 1,255 | 60% | No demand forecast for this item |
| `next_arrival_date` | 1,682 | 80% | No open POs |
| `prev90_unitsLY` | 1,472 | 70% | No LY sales data for this item + date |

**Notes:**
- **Warehouse-only inventory:** `ending_inventory` and `material_value` come from `inventory.inventory_daily WHERE location_type = 'warehouse'` only. This excludes customization, retail, amazon, and 3pl locations. This is a narrower scope than `inventory.item_sell_through` (which includes warehouse + customization).
- **Sales are all-channel:** `units_sold` and `sales_dollars` come from `analytics.item_metrics` without any channel filter — they include Web, Amazon, Retail, Wholesale, Customization, and all other channels.
- **Static (non-date-varying) columns:** `units_on_order`, `next_arrival_date`, and all `forecast_units_*` columns reflect current-day values and are the same across all historical dates. Do not use these for historical analysis — they only make sense for the current date.
- **LY columns are date-varying:** Unlike forecast/on-order columns, `prev90_unitsLY` and `next90_unitsLY` are properly matched to the historical date via a 1-year offset join, so they are valid for time-series analysis.
- **`is_instock` threshold:** Uses 110% of safety stock (`ending_inventory > 1.1 × safety_stock`). Items with NULL safety stock are treated as safety_stock = 0, so any inventory > 0 makes them in-stock.
- **`inventory_adjustment` interpretation:** Positive values mean inventory appeared (e.g., transfers in, corrections up). Negative values mean inventory disappeared (shrinkage, write-offs, transfers out). The field is NULL on the first date for each item (when `beginning_inventory` is NULL).
- **FIFO age extremes:** `avg_inventory_age_days` can be extremely large for items with very old receipt batches still on hand and minimal recent receipts. Filter to `avg_inventory_age_days < 1000` or similar for typical operational analysis.
- **Performance:** The view is a complex multi-CTE computation. Always filter by `date` for performance. Querying the full history (~5.8M rows) is expensive. For current-day snapshots: `WHERE date = CURRENT_DATE('America/Los_Angeles')`.
- **Excludes WHOLESALE items:** Items with `UPPER(title) LIKE '%WHOLESALE%'` are excluded at the `items` CTE level.
- **No business filter:** Unlike some other views, this does not filter by business — both RTIC and Cuero items are included.

**Common query patterns:**

```sql
-- Current inventory position by parent product
SELECT
  parent,
  pgc,
  SUM(ending_inventory) AS total_units,
  SUM(pallets_on_hand) AS pallets_on_hand,
  SUM(material_value) AS material_value,
  ROUND(SAFE_DIVIDE(SUM(ending_inventory), NULLIF(SUM(daily_demand_rate), 0)) / 7.0, 1) AS weeks_to_sell_through
FROM inventory.inventory_metrics_item_daily
WHERE date = CURRENT_DATE('America/Los_Angeles')
  AND lifecycle_status LIKE 'Active%'
GROUP BY 1, 2
ORDER BY total_units DESC

-- Items with aging inventory (high DIO)
SELECT
  title, ending_inventory, dio_days, avg_inventory_age_days,
  inventory_turns, lifecycle_status
FROM inventory.inventory_metrics_item_daily
WHERE date = CURRENT_DATE('America/Los_Angeles')
  AND ending_inventory > 0
  AND dio_days > 365
ORDER BY dio_days DESC

-- TY vs LY sales velocity comparison
SELECT
  title,
  units_sold_90d AS ty_units_90d,
  prev90_unitsLY AS ly_units_90d,
  ROUND(SAFE_DIVIDE(units_sold_90d - prev90_unitsLY, NULLIF(prev90_unitsLY, 0)) * 100, 1) AS pct_change,
  next90_unitsLY AS ly_next90_units
FROM inventory.inventory_metrics_item_daily
WHERE date = CURRENT_DATE('America/Los_Angeles')
  AND units_sold_90d > 100
  AND prev90_unitsLY > 0
ORDER BY units_sold_90d DESC

-- Inventory days trend over time for a product
SELECT
  date,
  ending_inventory,
  units_sold_90d,
  dio_days,
  avg_inventory_age_days
FROM inventory.inventory_metrics_item_daily
WHERE item_id = 20992
  AND date >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH)
ORDER BY date

-- Pre-sale / new items awaiting first arrival
SELECT
  lifecycle_status, pgc, title,
  ending_inventory AS units_on_hand,
  units_on_order,
  next_arrival_date
FROM inventory.inventory_metrics_item_daily
WHERE date = CURRENT_DATE('America/Los_Angeles')
  AND lifecycle_status LIKE 'Pre-Sale%'
  AND units_on_order > 0
ORDER BY next_arrival_date
```



---

### `replen.po_status`

**What it is:** A VIEW representing purchase order (PO) forecast status. One row per PO forecast × item. Shows what has been ordered, what has been received, what is on-the-water (OTW), and what remains outstanding. Contains ARRAY columns for container-level detail. ~14,920 rows total (~12,030 closed, ~2,890 open). Data goes back to 2022.

**Source tables:** Built from `c2s_public.po_forecasts`, `c2s_public.po_forecast_items`, `c2s_public.vendors`, `c2s_public.locations`, `c2s_public.divisions`, `c2s_public.item_versions`, `operations.receipts` (received units), `demand.receipt_forecast` (OTW container tracking), `c2s_freight.movement_ports` (container routing), and `analytics.items`.

| column | type | notes |
|---|---|---|
| forecast_id | INT64 | PO forecast identifier (from `c2s_public.po_forecasts.id`) |
| division_id | INT64 | Division identifier (NULL for old records) |
| division | STRING | Division name (e.g. `RTIC D2C`, `Wholesale`); NULL for old records |
| created | TIMESTAMP | When the PO forecast was created |
| closed | BOOL | Whether the PO forecast is closed/completed |
| memo | STRING | PO memo — may contain ship dates in MM/DD format |
| vendor | STRING | Vendor/manufacturer name |
| ship_date | DATE | Estimated ship/departure date (see derivation logic below) |
| destination | STRING | Destination location name: `Katy HQ`, `RJW`, or `Walmart Overseas` |
| title | STRING | Item title (from `analytics.items`) |
| parentName | STRING | Parent product name |
| pgc | STRING | Planning group category (e.g. `Drinkware`, `Hard Coolers`, `Soft Coolers`, `Other`) |
| pgn | STRING | Planning group name |
| item_id | INT64 | Item identifier — join key |
| version_id | INT64 | Item version identifier |
| version | STRING | Version name (e.g. `Original`, `Silicone Coaster Bottom`, `Updated Zipper`) |
| version_index | INT64 | Version index (0 or 1 = original; 2+ = subsequent versions) |
| rate | FLOAT64 | Unit cost rate (avg $16.84; range $0.01 – $225.00) |
| po_units | INT64 | Total units on the PO |
| received_units | INT64 | Units actually received (computed from `operations.receipts`) |
| otw_units | INT64 | Units currently on-the-water (in transit) |
| remaining_units | INT64 | Units **not yet shipped** from vendor (still at factory; excludes OTW and received) |
| excess_units | INT64 | `received_units + otw_units - po_units` — negative = still outstanding, positive = over-received |
| first_otw_delivery_date | DATE | Earliest expected delivery date among OTW containers |
| last_otw_delivery_date | DATE | Latest expected delivery date among OTW containers |
| first_otw_intransit_date | DATE | Earliest in-transit (departure) date among OTW containers |
| last_otw_intransit_date | DATE | Latest in-transit date among OTW containers |
| otw_first_delivery_date | DATE | Duplicate of `first_otw_delivery_date` (backward compatibility) |
| otw_last_delivery_date | DATE | Duplicate of `last_otw_delivery_date` (backward compatibility) |
| containers | ARRAY<STRUCT<container_number STRING, quantity INT64, delivery_date DATE, seqnum STRING>> | Container-level summary |
| container_detail | ARRAY<STRUCT<container_number STRING, item_id INT64, quantity INT64, delivery_date DATE, seqnum STRING, in_transit_timestamp TIMESTAMP, origin_port STRING, destination_port STRING, via_dallas BOOL, route STRING>> | Detailed container info including port and route |
| is_late | BOOL | Whether the PO line item is late (see logic below) |

**`ship_date` derivation logic (priority waterfall):**

1. **`estimated_ship_start`** — if present, used directly (preferred)
2. **`estimated_ship_end`** — used if `estimated_ship_start` is NULL
3. **`cargo_ready` + 7 days** — if both estimated_ship fields are NULL
4. **Parsed from `memo`** — regex extracts dates in `MM/DD` format from the free-text memo field; the earliest extracted date is used
5. **Fallback** — defaults to the next Sunday + 7 days

**`remaining_units` logic:**

```
IF closed THEN 0
ELSE GREATEST(0, po_units - received_units - otw_units)
```

For closed POs, `remaining_units` is always 0. For open POs, remaining = what has not yet shipped from vendor factory (excludes both received and OTW).

**`excess_units` logic:**

```
received_units + otw_units - po_units
```

Negative = units still outstanding. Positive = over-received or over-shipped. Note: this is the **inverse** of `po_units - received_units`.

**`is_late` logic:**

```
remaining_units > 0 AND ship_date < CURRENT_DATE() - 14 days
```

Currently ~438 open PO line items are late, representing ~630K remaining units.

**Categorical values for `division`:**

| value | row count |
|---|---|
| `RTIC D2C` | ~13,226 |
| `Wholesale` | ~1,262 |
| `Customization` | 8 |
| `RTIC Retail` | 3 |
| `Corporate` | 1 |
| NULL | 2 |

**Categorical values for `destination` (open POs):**

| value | row count |
|---|---|
| `Katy HQ` | 2,583 |
| `RJW` | 301 |
| `Walmart Overseas` | 6 |

**Top vendors (open POs by po_units):**

| vendor | open rows | po_units | received | otw | remaining |
|---|---|---|---|---|---|
| Zhejiang Yongheng Household (Cupworld) | 707 | 1.94M | 732K | 202K | 1.21M |
| Zhejiang Xianfeng Magnetic Materials | 563 | 1.69M | 617K | 293K | 789K |
| LUFENG OUTDOORS Cambodia (LIEFENG) | 617 | 1.22M | 331K | 431K | 477K |
| Hangzhou Everich Houseware | 188 | 691K | 311K | 197K | 189K |
| Zhejiang Zhuosheng Industry & Trade | 89 | 487K | 309K | 146K | 42K |
| Hyaline Product Company (Haiya) | 303 | 446K | 103K | 132K | 212K |
| Hongkong Natural Ice Lock (Ideallock) | 180 | 205K | 86K | 69K | 59K |
| R.K. PLASTIC (THAILAND) | 186 | 86K | 21K | 17K | 49K |

**Top origin ports (from `container_detail`):** `Ningbo, China`, `Phnom Penh, Cambodia`, `Sihanoukville, Cambodia`, `Laem Chabang, Thailand`

**Top destination ports:** `Houston, TX`, `Katy HQ`, `RJW Dallas`

**Notes:**
- Filter `WHERE NOT closed` to get open/active POs only
- Filter `WHERE created > '2022-06-01'` — pre-2022 data is sparse/test data
- `remaining_units` = units **not yet shipped** from vendor — does NOT include OTW or received
- `po_units - received_units` = total units outstanding = `remaining_units + otw_units`
- `excess_units` sign is inverted from intuition: positive = over-received, negative = still outstanding
- The ARRAY columns (`containers`, `container_detail`) require `UNNEST` to access row-level container data
- Both ARRAY columns are always populated — when no OTW data, they contain a single element with NULL values
- `ship_date` is derived from multiple sources (see derivation logic above) — treat as approximate
- Some records have test vendor data — filter `created > '2022-06-01'` for clean data
- `version_index` is NOT a strict 0-based index — `Original` appears at both index 0 and 1
- `otw_first_delivery_date` and `otw_last_delivery_date` are duplicates of `first_otw_delivery_date` and `last_otw_delivery_date`
- The final SELECT filters to rows where `po_units > 0 OR received_units > 0 OR otw_units > 0`
- `received_units` is computed by joining to `operations.receipts` and summing by forecast_id + item_id

**Common UNNEST patterns:**

```sql
-- Container-level receipt detail with routing
SELECT
  pos.forecast_id,
  pos.parentName,
  pos.item_id,
  cd.container_number,
  cd.quantity,
  cd.delivery_date,
  cd.origin_port,
  cd.destination_port,
  cd.route,
  cd.via_dallas
FROM replen.po_status pos
CROSS JOIN UNNEST(pos.container_detail) AS cd
WHERE NOT pos.closed
  AND cd.delivery_date IS NOT NULL
ORDER BY cd.delivery_date ASC

-- Next expected delivery per item
SELECT
  pos.item_id,
  pos.parentName,
  MIN(cd.delivery_date) AS next_delivery
FROM replen.po_status pos
CROSS JOIN UNNEST(pos.container_detail) AS cd
WHERE NOT pos.closed
  AND cd.delivery_date IS NOT NULL
  AND cd.delivery_date >= CURRENT_DATE()
GROUP BY 1, 2
ORDER BY next_delivery
```

**Join patterns:**

```sql
-- Link POs to actual receipts
JOIN operations.receipts r ON r.forecast_id = pos.forecast_id AND r.item_id = pos.item_id

-- Combine with current inventory for supply pipeline view
WITH inv AS (
  SELECT item_id, SUM(available_units) AS available_units
  FROM inventory.inventory_daily
  WHERE date = CURRENT_DATE('America/Los_Angeles')
    AND location_type IN ('warehouse', 'customization')
  GROUP BY item_id
)
SELECT
  i.parentName,
  inv.available_units,
  SUM(pos.otw_units) AS otw_units,
  SUM(pos.remaining_units) AS remaining_units,
  MIN(pos.first_otw_delivery_date) AS next_delivery
FROM analytics.items i
LEFT JOIN inv ON inv.item_id = i.id
LEFT JOIN replen.po_status pos ON pos.item_id = i.id AND NOT pos.closed
WHERE i.lifecycle_status IN ('Active / evergreen', 'Active / seasonal')
GROUP BY 1, 2
```


---

### `operations.receipts`

**What it is:** A BASE TABLE of actual inventory receipts. One row per item received per container per receiving location per date. Records when physical inventory arrived at a warehouse. Built by a scheduled query (`CREATE OR REPLACE TABLE`) that joins `c2s_public.itemreceipts`, `c2s_public.itemreceiptitems`, PO/vendor tables, `analytics.items`, and `c2s_freight` cost data. Rebuilt ~daily (93 runs in last 90 days). ~44,300 rows total, covering data from 2016-08-23 to present (practical data starts ~2020).

**Granularity:** One row = one item × one container × one receiving location × one date. If a single container delivers multiple items, there is one row per item. The table aggregates at the `(date, shipment_id, container_number, po_id, forecast_id, vendor, item_id, location_id)` grain.

**Scale:** ~44,300 rows. ~5,300 unique containers since 2024. Average ~1,117 units received per row (for rows with units > 0).

**Annual volume:**

| Year | Rows | Units received | Containers |
|---|---|---|---|
| 2020 | 2,351 | 4.4M | 932 |
| 2021 | 3,878 | 6.6M | 1,663 |
| 2022 | 3,606 | 5.8M | 1,084 |
| 2023 | 4,921 | 5.2M | 1,509 |
| 2024 | 7,833 | 7.5M | 2,814 |
| 2025 | 5,474 | 6.4M | 1,948 |
| 2026 (partial) | 1,257 | 2.0M | 584 |

**Column reference:**

| column | type | notes |
|---|---|---|
| date | DATE | Date the inventory was received — derived from `COALESCE(unloaded_timestamp, processed_timestamp)` |
| container_number | STRING | Container/shipment identifier (e.g. `TLLU5533586`). Never NULL |
| po_id | INT64 | PO identifier from `c2s_public.porders`. **Almost always NULL** — only 4 rows have a non-NULL value. The `forecast_id` column is the practical PO link |
| forecast_id | INT64 | PO forecast identifier — **primary PO join key**. Non-NULL on 99.99% of rows. Join to `replen.po_status.forecast_id` |
| vendor | STRING | Vendor name. **Almost always NULL** (only 4 rows have a value) because `po_id` is rarely populated. To get vendor info, join through `replen.po_status` using `forecast_id` |
| item_id | INT64 | Item identifier — join key to `analytics.items.id` and all other tables |
| category_path | STRING | Category hierarchy from `analytics.items` |
| parentName | STRING | Parent product name from `analytics.items` |
| variantName | STRING | Variant name from `analytics.items` |
| color | STRING | Color from `analytics.items` |
| size | STRING | Size from `analytics.items` |
| business | STRING | Always `RTIC` — only one business value exists in this table |
| reporting_division | STRING | Always `Warehouse Operations` — hardcoded in the source query |
| location_id | INT64 | Receiving location identifier |
| location | STRING | Receiving location name (e.g. `Katy HQ`, `Gateway`). **Note: column is named `location`, not `location_name`** |
| units_received | INT64 | Number of units received. Can be 0 for pre-receipt rows (713 rows have 0; 43,598 rows are positive) |
| rate | FLOAT64 | Unit material cost rate at time of receipt. Never NULL. Average ~$29.23 |
| freight | STRUCT | Freight and duty cost details — see sub-fields below |

**`freight` STRUCT sub-fields:**

| field | type | notes |
|---|---|---|
| shipment_id | STRING | Freight shipment identifier. Non-NULL on ~45% of positive-receipt rows |
| container_base_cost | FLOAT64 | Base freight cost for the entire container |
| container_assessorial_cost | FLOAT64 | Assessorial cost for the entire container (demurrage, detention, etc.) |
| containers_received | FLOAT64 | Fraction of container's total units attributable to this SKU (unit-based allocation) |
| containers_received_materials | FLOAT64 | Fraction of container's total material value attributable to this SKU (value-based allocation for duty) |
| freight_base_per_unit | FLOAT64 | Base freight cost per unit. Average ~$4.36 where populated. NULL when no freight data |
| freight_assessorial_per_unit | FLOAT64 | Assessorial freight cost per unit. NULL when no freight data |
| shipment_duty_rate | FLOAT64 | Duty rate for the entire shipment = `total_duty / total_material_value` |
| duty_per_unit | FLOAT64 | Duty cost per unit = `shipment_duty_rate × rate`. Average ~$4.97 where populated |

**Freight data coverage:** ~45% of positive-receipt rows have freight data populated. The remainder have NULL freight fields (older receipts or unmatched freight invoices).

**Freight allocation logic:**
- **Base freight and assessorial costs** are allocated based on **unit count** — each unit gets an equal share regardless of item value
- **Duty** is allocated based on **material value** — `duty_per_unit = shipment_duty_rate × rate`, so higher-cost items bear proportionally more duty

**Receiving locations:**

| location_id | location | rows | units_received | notes |
|---|---|---|---|---|
| 20 | Katy HQ | 17,730 | 20.8M | Primary warehouse — headquarters |
| 8 | Gateway | 11,403 | 21.9M | Primary warehouse — highest volume |
| 2 | Hempstead | 8,195 | 20.0M | Primary warehouse |
| 25 | RJW | 2,105 | 3.9M | 3PL partner |
| 12 | Alamo Crossing | 2,865 | 2.5M | Warehouse |
| 24 | Walmart Overseas | 1,333 | 615K | Direct-to-retailer overseas |
| 10 | Lowes Overseas | 612 | 511K | Direct-to-retailer overseas |
| 14 | Remote Container Storage, Houston | 30 | 491K | Overflow storage |

**Notes:**
- `vendor` and `po_id` are almost always NULL. To get vendor information, join to `replen.po_status` via `forecast_id`
- `units_received` can be 0 for 713 rows — pre-receipt placeholder rows
- `rate` is the **material cost per unit** (not selling price) — never NULL
- `location` is the column name — there is no `location_name` column
- `container_number` links to `replen.po_status.container_detail.container_number` for full container tracking (requires UNNEST on po_status side)
- Only `RTIC` business receipts are present — Cuero inventory receipts are not in this table
- For clean analysis, filter `WHERE units_received > 0` to exclude zero-receipt rows

**Calculating total landed cost per unit:**

```sql
SELECT
  r.item_id,
  r.parentName,
  r.rate AS material_cost_per_unit,
  r.rate
    + COALESCE(r.freight.freight_base_per_unit, 0)
    + COALESCE(r.freight.freight_assessorial_per_unit, 0)
    + COALESCE(r.freight.duty_per_unit, 0) AS total_landed_cost_per_unit
FROM operations.receipts r
WHERE r.units_received > 0
```

**Common query patterns:**

```sql
-- Recent receipts by item (last 30 days)
SELECT
  r.date,
  r.container_number,
  r.parentName,
  r.variantName,
  r.location,
  r.units_received,
  r.rate,
  r.units_received * r.rate AS receipt_material_value
FROM operations.receipts r
WHERE r.date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND r.units_received > 0
ORDER BY r.date DESC, r.container_number

-- Receipt volume and landed cost by month
SELECT
  DATE_TRUNC(r.date, MONTH) AS month,
  COUNT(DISTINCT r.container_number) AS containers,
  SUM(r.units_received) AS units,
  ROUND(SUM(r.units_received * r.rate), 0) AS material_value,
  ROUND(SUM(r.units_received * (r.rate
    + COALESCE(r.freight.freight_base_per_unit, 0)
    + COALESCE(r.freight.freight_assessorial_per_unit, 0)
    + COALESCE(r.freight.duty_per_unit, 0))), 0) AS landed_value
FROM operations.receipts r
WHERE r.units_received > 0
  AND r.date >= '2024-01-01'
GROUP BY 1
ORDER BY 1

-- PO forecast vs. actual receipt reconciliation
SELECT
  pos.forecast_id,
  pos.parentName,
  pos.po_units,
  pos.received_units AS po_received_units,
  SUM(r.units_received) AS actual_receipt_units,
  pos.po_units - SUM(r.units_received) AS variance
FROM replen.po_status pos
JOIN operations.receipts r ON r.forecast_id = pos.forecast_id
WHERE r.units_received > 0
  AND r.date >= '2024-01-01'
GROUP BY 1, 2, 3, 4
ORDER BY variance DESC
```



---

### `c2s_public.itempacking`

**What it is:** One row per item × UOM combination. Stores the physical dimensions, weight, and fulfillment attributes for each packing configuration of an item. The most important use case is accessing each-level dimensions (length, width, height in mm) and weight for shipping cost analysis. Join on `item_id` and filter to `uom_id = 1` for individual unit dimensions.

| column | type | notes |
|---|---|---|
| id | INT64 | Primary key |
| item_id | INT64 | Item identifier — join key to `analytics.items.id` and all other tables |
| uom_id | INT64 | Unit of measure ID — `1` = Each (individual unit); other values = case packs. Join to `c2s_public.uom` for details |
| length_mm | INT64 | Packed length in millimeters — NULL or 0 for some items without dimension data |
| width_mm | INT64 | Packed width in millimeters |
| height_mm | INT64 | Packed height in millimeters |
| weight | STRING | Packed weight in pounds — stored as STRING, use `SAFE_CAST(weight AS FLOAT64)` for numeric operations |
| box_volume | STRING | Box volume — stored as STRING; use `SAFE_CAST(box_volume AS FLOAT64)` |
| maxperpackage | STRING | Maximum units per shipment package |
| abbreviation | STRING | Short packing code/identifier |
| can_ship_unboxed | BOOL | Whether the item can ship without a box (e.g. polybag or bare) |
| single_uses_whole_box | BOOL | Whether a single unit occupies the entire box (large/bulky items) |
| is_conveyable | BOOL | Whether the item can travel on a conveyor belt in the warehouse |
| pack_strategy | STRING | `boxed` (vast majority) or `stacked` |

**Categorical values for `pack_strategy`:** `boxed` (~11,355 rows), `stacked` (~184 rows — heavier items, avg weight 27 lbs)

**Coverage:** ~7,180 items have `uom_id = 1` (each-level) packing records. ~446 items have NULL or zero dimensions.

**Notes:**
- Always filter `WHERE uom_id = 1` to get individual unit dimensions for shipping analysis
- `weight` and `box_volume` are STRING columns — always `SAFE_CAST` before arithmetic
- Dimensions are in **millimeters** — divide by 25.4 for inches or 1000 for meters
- Items with `single_uses_whole_box = TRUE` are bulky items (coolers, chairs, etc.) — each unit ships in its own box
- Items with `can_ship_unboxed = TRUE` can ship in polybag/bare, enabling cheaper shipping services
- `is_conveyable = FALSE` items require manual handling in the warehouse (large, heavy, or awkward)
- Some items have `length_mm = 0` despite `pack_strategy = 'boxed'` — treat 0 as missing data same as NULL

**Join to get each-level dimensions:**
```sql
JOIN c2s_public.itempacking ip ON ip.item_id = i.id AND ip.uom_id = 1
```

---

---

### `c2s_public.uom`

**What it is:** Lookup table for units of measure. Defines each UOM's name, conversion factor (units per case), and category. Used to interpret `uom_id` values in `itempacking` and `analytics.item_metrics`.

| column | type | notes |
|---|---|---|
| id | INT64 | Primary key — the `uom_id` used in other tables |
| uom | STRING | Short code (e.g. `CS`, `EA`) |
| name | STRING | Full name (e.g. `Each`, `Case of 24`) |
| name_plural | STRING | Plural name |
| conversion | INT64 | Number of base units (eaches) per this UOM — e.g. 24 for "Case of 24" |
| is_base | BOOL | `TRUE` only for `id = 1` (Each) |
| uom_category | STRING | `case` for case packs; NULL for non-case UOMs |
| edi_code | STRING | EDI standard code (e.g. `EA`, `CA`) |
| itf_prefix | INT64 | ITF-14 barcode prefix |

**Key values:**

| id | name | conversion | is_base | notes |
|---|---|---|---|---|
| 1 | Each | 1 | TRUE | Individual unit — always use this for single-item dimensions/weight |
| 22 | Case of 24 | 24 | FALSE | Most common case pack (920 items) |
| 84 | Case of 4 | 4 | FALSE | 2nd most common (635 items) |
| 23 | Case of 100 | 100 | FALSE | Small items (382 items) |
| 6 | Case of 48 | 48 | FALSE | 340 items |
| 37 | Case of 12 | 12 | FALSE | 265 items |

**Notes:**
- `uom_id = 1` is always the individual "each" unit — the correct join for per-unit dimensions and weight
- `conversion` = number of eaches per case — multiply by unit cost/weight to get case-level values
- Many `uom` values share the code `CS` — use `name` or `id` for unambiguous identification
- `is_base = TRUE` only for `id = 1`

---

---

### `inventory.item_sell_through`

**What it is:** A VIEW with one row per item. Combines current warehouse inventory (`inventory.inventory_daily`) with demand forecasts and sales history to produce a daily demand rate and sell-through estimate for each item. Created 2026-03-16. Use this as the primary source for sell-through analysis — do not recompute from raw tables.

| column | type | notes |
|---|---|---|
| item_id | INT64 | Item identifier — join key to `analytics.items` and all other tables |
| title | STRING | Full SKU title |
| parent | STRING | Parent product name (equivalent to `analytics.items.parentName`) |
| type | STRING | Product type |
| pgc | STRING | Planning group category (equivalent to `analytics.items.planning_group_category`) |
| pgn | STRING | Planning group name |
| lifecycle_status | STRING | Item lifecycle status — same values as `analytics.items.lifecycle_status` |
| business | STRING | `RTIC` or `Cuero` |
| available_units | FLOAT64 | Current available units in warehouse/customization locations |
| units_on_order | INT64 | Units on open POs not yet received = `remaining_units + otw_units` (not-yet-shipped + on-the-water) |
| total_supply | FLOAT64 | `available_units + units_on_order` |
| daily_demand_rate | FLOAT64 | Daily demand rate used for sell-through calculation; NULL if no demand data |
| demand_source | STRING | How `daily_demand_rate` was derived: `forecast` (uses replen forecast) or `sales_history` (uses recent sales); NULL if no data |
| days_to_sell_through | FLOAT64 | `available_units / daily_demand_rate`; NULL if no demand rate; 0 if available_units = 0 |
| weeks_to_sell_through | FLOAT64 | `days_to_sell_through / 7`; NULL if no demand rate |

**Notes:**
- `units_on_order` = `remaining_units + otw_units` from `replen.po_status`. `remaining_units` alone is units not yet shipped (still at factory) and would undercount — OTW units (shipped, in transit) must be included to get all units not yet received
- `available_units` reflects warehouse + customization inventory only (same scope as `inventory.inventory_daily WHERE location_type IN ('warehouse', 'customization')`)
- `daily_demand_rate` is NULL for items with no forecast and no recent sales history — treat NULL as infinite sell-through
- For excess inventory analysis: filter `weeks_to_sell_through > 26` OR `lifecycle_status = 'Post-Sale / discontinued'`; use `COALESCE(weeks_to_sell_through, 9999) > 26` to include NULL-demand items
- **Excess units formula:** for discontinued items = `available_units` (all are excess); for active items = `GREATEST(0, available_units - ROUND(daily_demand_rate * 182))`
- This view does NOT include material costs or pallet counts — join to `inventory.inventory_daily` for material_costs and `analytics.items` for `pallet_quantity`

---

---

### `analytics.return_metrics`

**What it is:** The primary return/refund fact table. One row per order × item × return event (`return_id`). Built by the "item_metrics 4.0" scheduled query, joining `analytics.item_metrics` with `c2s_public.returns`, `c2s_public.returnitems`, `c2s_public.returnreceiveditems`, disposition references, reason codes, and return shipment costs. Covers data back to ~2016. Refreshed on the same schedule as `analytics.item_metrics`.

**Granularity:** One row = one order line item × one return. If a customer opens multiple RMAs for the same order item, there will be multiple rows (one per `return_id`). A row exists once any of the following is true: an RMA line item (`returnitem`) exists OR a physical return receipt (`returnreceiveditem`) exists for that order × item.

**Key dates:**

| column | type | notes |
|---|---|---|
| `order_date` | TIMESTAMP | When the original order was placed — same value as in `analytics.item_metrics` |
| `first_fulfillment_date` | TIMESTAMP | Earliest fulfillment date across all shipments of this order × item |
| `last_fulfillment_date` | TIMESTAMP | Latest fulfillment date across all shipments of this order × item |
| `rma_date` | TIMESTAMP | When the RMA was created (earliest `returns.created` across all RMAs for this order × item) |
| `return_received_date` | TIMESTAMP | When the physical item was received back at the warehouse (latest `returnreceiveditems.received`) |

**Column reference:**

| column | type | notes |
|---|---|---|
| `order_id` | INT64 | Order identifier — join to `analytics.item_metrics` |
| `item_id` | INT64 | Item identifier — join to `analytics.items` |
| `return_id` | INT64 | Return (RMA) identifier from `c2s_public.returns` |
| `returnitem_id` | INT64 | Return line item identifier from `c2s_public.returnreceiveditems`; NULL if return not yet received |
| `is_expected` | BOOL | TRUE if the item appears in the RMA manifest (a `returnitem` record exists); FALSE if item arrived without a prior RMA |
| `in_original_order` | BOOL | TRUE if the returned item_id was actually part of the original order (rate > 0); FALSE may indicate a mis-ship, size swap, or fraud |
| `product` | STRING | Parent product name (`analytics.items.parentName`) |
| `units_sold` | FLOAT64 | Units sold on the original order × item (from `item_metrics.base_quantity`) |
| `sales` | FLOAT64 | Total revenue on the original order × item |
| `COGS` | FLOAT64 | Total cost on the original order × item (`total_cost` from item_metrics) |
| `shipping_cost` | FLOAT64 | Outbound shipping cost on the original order × item |
| `shipping_paid` | FLOAT64 | Shipping revenue collected on the original order × item |
| `rma_count` | INT64 | Number of distinct RMAs associated with this order × item |
| `units_returned` | INT64 | Physical units received back. For `resolution = 'replace'`, only counts units if the item was in the original order — prevents double-counting when a customer swaps to a different size or condition |
| `disposition` | STRING | How the returned item was processed (see categorical values below) |
| `disposition_scrap` | BOOL | TRUE if `disposition = 'Scrap'` |
| `disposition_rti` | BOOL | TRUE if `disposition = 'Return to Inventory'` |
| `disposition_open_box` | BOOL | TRUE if `disposition = 'Resell As Open Box'` |
| `returned_sales` | FLOAT64 | `units_returned × (sales / units_sold)` — value of returned units at original sale price |
| `returned_COGS` | FLOAT64 | `units_returned × (COGS / units_sold)` — cost basis of returned units |
| `refunded_sales` | FLOAT64 | `returned_sales` for units where `resolution = 'refund'` only — money actually refunded to the customer |
| `refunded_COGS` | FLOAT64 | `returned_COGS` for refunded units only |
| `return_shipping_cost` | FLOAT64 | Inbound return shipping cost (customer → warehouse), from `c2s_public.returnshipments` |
| `units_replaced` | INT64 | Units sent as replacement items (for `resolution = 'replace'` returns) |
| `replacement_material_cost` | FLOAT64 | Material cost of replacement items sent (`units_replaced × materials_avg`) |
| `reasons` | STRING | Pipe-delimited list of return reasons (e.g. `No Longer Wanted`, `Manufacturer Defect|Broken zipper`) |
| `is_warranty` | BOOL | TRUE if any return reason is flagged as a warranty claim |

**Categorical values for `disposition`:**

| value | row count | meaning |
|---|---|---|
| `Return to Inventory` | ~99,700 | Item inspected and restocked as sellable |
| `Unspecified` | ~98,100 | Disposition was recorded but not classified — distinct from NULL |
| `Scrap` | ~58,800 | Item destroyed or disposed of (damaged, unsalvageable) |
| `Resell As Open Box` | ~45,300 | Item sold at a discount as open box / clearance |
| NULL | ~44,300 | No disposition recorded — typically `is_expected = FALSE` (received without RMA) or RMA not yet received |
| `Resell As New` | ~14 | Rare — item resold as new |
| `Rework` | ~3 | Rare — item sent for rework/repair |

**Top `reasons` values** (pipe-delimited when multiple):

`No Longer Wanted`, `Other`, `Damaged`, `Manufacturer Defect`, `Incorrect Item Shipped`, `Unexpected Item Shipped`, `Duplicate Order`, `Damaged in Shipping`, `Broken zipper`, `Exterior cosmetic damage`, `Seam coming apart`, `Zipper too hard to open`, `Fit too large`, `Fit too small`, `Received Dirty`, `Wrong Color in Box`

**Categorical values for `resolution`:**

| value | meaning | refunded_sales | units_replaced | notes |
|---|---|---|---|---|
| `refund` | Customer received a money-back refund | = `returned_sales` | minimal | Most common resolution (~208K rows all-time). `refunded_sales` exactly equals `returned_sales` for these rows. |
| `replace` | Customer received a replacement unit | 0 | high | `units_replaced` and `replacement_material_cost` are populated. Replacement can exceed units returned (e.g. sending extras). |
| `other` | Catch-all: store credit, exchange, or partial resolution | 0 | low | No cash refund issued. Some `units_replaced` may be present. Includes exchanges and non-standard resolutions. |
| NULL | Resolution not recorded | 0 | none | Typically unresolved RMAs, very old records, or returns received without a formal resolution workflow. |

**Notes:**
- **Pending returns:** Rows where `return_received_date IS NULL` (~18,900 rows) represent RMAs opened but not yet physically received — the item has not come back yet
- **Unsolicited returns:** `is_expected = FALSE` means the item arrived without an RMA. These may be customer errors, freight carrier returns, or fraud
- **`in_original_order = FALSE`:** The item being returned was not in the original order at that rate — can indicate a size/item swap on a 'replace' resolution, or an error
- **`disposition = NULL` vs `disposition = 'Unspecified'`:** NULL means no disposition was entered; `Unspecified` is a recorded but unclassified disposition — both are operationally ambiguous
- **`return_shipping_cost`** is the cost of the inbound (customer → warehouse) return label, not the original outbound shipping. It is 0 when the customer arranged their own return or when no prepaid label was issued
- **`COGS` column** = `total_cost` from item_metrics (not `material_cost`) — includes material, shipping, duties, and fees on the original order
- **`returned_sales` ≠ `refunded_sales`:** Many returns are replacements, not refunds. A return with `units_returned > 0` and `refunded_sales = 0` means the customer got a replacement, not money back
- **Unused CTEs:** The source SQL contains `units` and `dates` CTEs that are not used in the final SELECT — they are leftover scaffolding and have no effect on the output
- All TIMESTAMP columns follow the same Central Time convention as `analytics.item_metrics`
- Table has ~346K rows total; ~325K have `units_returned > 0` (physically received); ~262K have a `return_shipping_cost` recorded

**Common query patterns:**

```sql
-- Return rate by product (units returned / units sold)
SELECT
  rm.product,
  SUM(rm.units_sold) AS units_sold,
  SUM(rm.units_returned) AS units_returned,
  ROUND(SAFE_DIVIDE(SUM(rm.units_returned), SUM(rm.units_sold)), 4) AS return_rate
FROM analytics.return_metrics rm
WHERE CAST(rm.order_date AS DATE) >= DATE_SUB(CURRENT_DATE('America/Chicago'), INTERVAL 365 DAY)
GROUP BY 1
ORDER BY units_returned DESC

-- Financial cost of returns (full P&L impact)
SELECT
  rm.product,
  SUM(rm.returned_sales) AS returned_sales,
  SUM(rm.refunded_sales) AS refunded_sales,
  SUM(rm.returned_COGS) AS returned_COGS,
  SUM(rm.return_shipping_cost) AS inbound_return_shipping,
  SUM(rm.replacement_material_cost) AS replacement_cost
FROM analytics.return_metrics rm
WHERE rm.return_received_date >= TIMESTAMP(DATE_SUB(CURRENT_DATE('America/Chicago'), INTERVAL 90 DAY))
  AND rm.units_returned > 0
GROUP BY 1
ORDER BY refunded_sales DESC

-- Warranty vs. non-warranty return disposition mix
SELECT
  is_warranty,
  disposition,
  COUNT(*) AS row_count,
  SUM(units_returned) AS units_returned
FROM analytics.return_metrics
WHERE units_returned > 0
GROUP BY 1, 2
ORDER BY is_warranty DESC, units_returned DESC
```

---

---

### `c2s_public.packages`

**What it is:** One row per physical outbound shipping package. Tracks each parcel from label creation through carrier pickup, transit, and delivery. Contains physical dimensions, carrier tracking, shipping cost (accrual and billed), delivery status, and exception details. ~16.6M rows total.

**Join to `analytics.item_metrics`:**
```sql
JOIN c2s_public.packages p ON p.id = im.package_id
```
- Join key: `item_metrics.package_id = c2s_public.packages.id`
- **Many item_metrics rows → one package** — multiple line items can ship in the same box
- 100% referential integrity: every non-null `package_id` in `item_metrics` has a matching record here
- ~80% of item_metrics rows have a non-null `package_id`; the remaining ~20% are unfulfilled, retail, or non-shipped orders

**Cardinality:**

| items per package | package count | % of packages |
|---|---|---|
| 1 | 2,206,566 | 70% |
| 2 | 503,560 | 16% |
| 3 | 250,960 | 8% |
| 4+ | ~310,000 | 10% (bulk/B2B orders can have 10–20+ items per package) |

| packages per order | order count | % of orders |
|---|---|---|
| 1 | 2,383,941 | 91% |
| 2 | 136,721 | 5% |
| 3+ | ~95,000 | 4% (large or multi-shipment orders) |

**Column reference:**

| column | type | notes |
|---|---|---|
| `id` | INT64 | Primary key — matches `item_metrics.package_id` |
| `shipment_id` | INT64 | Parent shipment identifier — joins to `c2s_public.shipments`; one shipment can have multiple packages |
| `status` | STRING | Current delivery status (see categorical values below) |
| `tracking_number` | STRING | Carrier tracking number |
| `length` | STRING | Package length in inches (cast to FLOAT64 to use numerically) |
| `width` | STRING | Package width in inches |
| `height` | STRING | Package height in inches |
| `weight` | STRING | Package weight in lbs |
| `box` | STRING | Box type code (e.g. `A`, `B`, `540`, `V2A`) — references a box template |
| `accrual_cost` | STRING | **Accrued shipping cost** — estimated at label creation; cast to FLOAT64. For single-item packages, exactly equals `item_metrics.shipping_cost`. For multi-item packages, `accrual_cost` is the full package cost and `item_metrics.shipping_cost` is its allocation across line items. |
| `billed_cost` | STRING | **Actual carrier-billed cost** — populated after carrier invoice reconciliation; cast to FLOAT64. Averages ~1.3% higher than `accrual_cost` ($13.51 vs $13.34). NULL until reconciled. |
| `billed_before_accrual` | BOOL | TRUE for ~281 packages where billing arrived before accrual was recorded — rare edge case |
| `void` | BOOL | TRUE if the shipping label was voided/cancelled |
| `void_requested` | BOOL | TRUE if a void was requested but not yet confirmed |
| `cleared` | BOOL | TRUE when the package is closed out of the active queue. Cleared packages have NULL costs. |
| `packed_at` | TIMESTAMP | When the package was packed and label created |
| `loaded_at` | TIMESTAMP | When loaded onto the carrier truck |
| `first_carrier_scan` | TIMESTAMP | First carrier scan — marks actual physical pickup |
| `delivered_at` | TIMESTAMP | When delivered to the customer |
| `promise_date` | TIMESTAMP | Promised/SLA delivery date |
| `status_updated` | TIMESTAMP | When `status` was last updated |
| `tracking_polled_at` | TIMESTAMP | Last time carrier tracking was polled |
| `exception_reason_code` | STRING | Carrier exception code (see values below); NULL if no exception |
| `exception_reason_description` | STRING | Free-text exception description |
| `exception_resolution_code` | STRING | Resolution code; mostly NULL (most exceptions auto-resolve) |
| `cancellation_requested_at` | TIMESTAMP | When void/cancellation was requested |
| `cancellation_confirmed_at` | TIMESTAMP | When void/cancellation was confirmed |
| `shipengine_tracking` | BOOL | Whether tracking is managed via ShipEngine |
| `premadebox_id` | INT64 | Pre-configured box template used for packing |
| `pallet_id` | INT64 | Pallet this package is on (B2B/retail bulk shipments) |
| `sscc_prefix` / `sscc_id` | STRING / INT64 | Serial Shipping Container Code — used for EDI/retail shipments |
| `attributes` | JSON | Additional metadata as JSON |
| `packed_by` / `loaded_by` | INT64 | User IDs of warehouse staff who packed/loaded |

**Categorical values for `status`:**

| value | row count | meaning |
|---|---|---|
| `Delivery` | ~16.1M | Delivered (or tracking not yet updated — see note) |
| NULL | ~384K | Status not yet set (very recent packages) |
| `In Transit` | ~126K | Currently in transit with carrier |
| `Exception` | ~31K | Delivery exception (damage, address issue, etc.) |
| `Out for Delivery` | ~4.4K | On the truck for final delivery |
| `Voiding` | ~1,140 | Void in progress |
| `Voided` | ~44 | Label permanently voided |

**Void / Cleared states:**

| void | cleared | meaning | costs recorded? |
|---|---|---|---|
| NULL | FALSE | Normal active/delivered package | Yes — `accrual_cost` and `billed_cost` populated |
| NULL | TRUE | Completed and cleared from active queue | No — cleared packages have NULL costs |
| TRUE | TRUE | Voided and cleared | No |
| TRUE | FALSE | Being voided (rare) | No |

**Top exception reason codes:**

| code | meaning | count |
|---|---|---|
| `SD` | Service disruption | ~3,300 |
| `DE` | Delivery exception | ~930 |
| `SE` | Shipment exception | ~620 |
| `WTH` | Weather delay | ~89 |
| `LOS` | Package lost | ~85 |
| `RS` | Return to sender | ~60 |
| `RTS` | Return to sender (variant) | ~37 |

**Key relationships:**
- `accrual_cost` is the **total package shipping cost** — `item_metrics.shipping_cost` is this same value split across line items proportionally
- `billed_cost` vs `accrual_cost` difference = shipping cost variance; useful for carrier invoice reconciliation analysis
- `delivered_at - first_carrier_scan` = actual transit time (more accurate than `fulfillment_date` to `delivery_date` in item_metrics)
- Filter `WHERE void IS NULL` to exclude voided labels when calculating costs or shipment counts

**Notes:**
- `accrual_cost` and `billed_cost` are stored as STRING — always `SAFE_CAST(accrual_cost AS FLOAT64)` before aggregating
- `cleared = TRUE` packages have NULL for both cost columns — filter `WHERE cleared = FALSE` when studying shipping economics
- `length`, `width`, `height`, `weight` are also STRING — cast to FLOAT64 for dimensional calculations
- `status = 'Delivery'` does NOT guarantee the package was delivered — some packages get stuck in this status without a `delivered_at` timestamp. Use `delivered_at IS NOT NULL` for confirmed delivery

---

---

### `retail.daily`

**What it is:** A VIEW with one row per date × retail location × item. Aggregates daily point-of-sale (POS) sales, returns, and on-hand inventory data from four retail partners — Walmart, Target, Lowe's, and West Marine — sourced from the Alloy retail data feed (`alloy-prod-customer-exports.rticoutdoors.*`). Also enriched with RTIC category hierarchy (from `analytics.items`) and an estimated unit cost derived from trailing wholesale sales in `analytics.item_metrics`. This is the primary table for retail channel analysis. ~90.7M rows total, from 2023-11-10 to present.

**Source tables:**
- `alloy-prod-customer-exports.rticoutdoors.data` — raw Alloy POS/inventory data
- `alloy-prod-customer-exports.rticoutdoors.location` — store/DC location attributes
- `alloy-prod-customer-exports.rticoutdoors.product` — product mapping with RTIC ID recovery logic
- `alloy-prod-customer-exports.rticoutdoors.segment` — Alloy segment metadata
- `analytics.items` — for category hierarchy (`category_path` split into 3 levels)
- `analytics.item_metrics` — for estimated wholesale cost calculation (rolling 6-month avg)
- `retail.stores_realized` — for West Marine geo data (state, zip, city, lat/long) not available in Alloy

**Data coverage:**

| Retailer | Locations | Items | Earliest Date | Net Sales (all-time) |
|---|---|---|---|---|
| Walmart | 4,193 | 195 | 2023-12-09 | $104M |
| Target | 2,025 | 119 | 2023-11-10 | $22.3M |
| Lowe's | 1,730 | 147 | 2024-01-28 | $11.4M |
| West Marine | 244 | 71 | 2024-05-21 | $2.7M |

**Column reference:**

| column | type | notes |
|---|---|---|
| `date` | DATE | POS date |
| `retailer` | STRING | Partner name: `Walmart`, `Target`, `Lowe's`, `West Marine` |
| `location_number` | STRING | Retailer's store/DC identifier |
| `location_name` | STRING | Store name |
| `state` | STRING | State — uses `retail.stores_realized` as fallback for West Marine; NULL for ~55K rows |
| `zip` | STRING | Postal code — same fallback logic as `state` |
| `city` | STRING | City — same fallback logic as `state` |
| `Address1` | STRING | Street address from Alloy location data; NULL for West Marine and some Walmart locations |
| `latitude` | FLOAT64 | Store latitude — cast from STRING in source; West Marine uses `retail.stores_realized` fallback |
| `longitude` | FLOAT64 | Store longitude — same fallback logic as latitude |
| `location_type` | STRING | `Store` (~89.9M rows), `Distribution Center` (~864K rows), or NULL (~360 rows) |
| `fulfillment_method` | STRING | `Store` (~88.6M rows), `DC to Home` (~55K rows), or NULL (~2M rows) |
| `channel` | STRING | `In-store` (~89.7M rows) or `e-Commerce` (~1M rows) — see derivation logic below |
| `item_id` | STRING | RTIC item ID — **stored as STRING**, must `SAFE_CAST(item_id AS INT64)` to join to `analytics.items` |
| `title` | STRING | RTIC item description |
| `target_name` | STRING | Target's product description (NULL for non-Target rows) |
| `target_dcpi` | STRING | Target DPCI number |
| `retailer_item_number` | STRING | Retailer's own item number — COALESCE of `Walmart Prime Item Nbr`, `Target DPCI`, `Lowe's ID`, or `West Marine Item ID` (whichever applies) |
| `retailer_item_name` | STRING | Retailer's product name — COALESCE of Target, Walmart, West Marine, or Lowe's descriptions with fallback formatting |
| `sales_gross` | FLOAT64 | Gross POS sales (before returns), in USD |
| `sales_net` | FLOAT64 | Net POS sales (after returns), in USD — use this for revenue reporting |
| `units_gross` | FLOAT64 | Gross units sold (before returns) |
| `units_net` | FLOAT64 | Net units sold (after returns) — use this for unit reporting |
| `return_sales` | FLOAT64 | Return value in USD |
| `return_units` | FLOAT64 | Return unit count |
| `inventory_units` | FLOAT64 | On-hand units at this location on this date |
| `est_cost` | FLOAT64 | Estimated RTIC wholesale price per unit — see calculation logic below; NULL when no historical wholesale sales exist |
| `segment_id` | INT64 | Alloy segment identifier |
| `product_id` | INT64 | Alloy product identifier |
| `category1` | STRING | Top-level category from `analytics.items.category_path` (e.g. `Drinkware`, `Hard Coolers`, `Soft Coolers`, `Travel`, `Uncategorized`) |
| `category2` | STRING | Mid-level category (e.g. `Tumblers`, `Ultra-Light`, `Day Coolers`) |
| `category3` | STRING | Leaf-level category (e.g. `Road Trip`, `22 QT`, `Lunch Bags`) |

**`est_cost` calculation logic:**

The `est_cost` column represents RTIC's estimated wholesale price per unit sold TO the retailer (not the consumer price). It is computed as a rolling 6-month average:

```sql
-- For each month × item × retailer:
SUM(sales) / SUM(base_quantity)
FROM analytics.item_metrics
WHERE order_sales_channel_group = 'Wholesale'
  AND DATE(order_date) BETWEEN DATE_ADD(month_start, INTERVAL -6 MONTH) AND month_start
```

The view generates a date array of monthly boundaries going back 24 months and, for each month, calculates the average wholesale revenue per unit from `analytics.item_metrics` where `order_sales_channel_group = 'Wholesale'`. The retailer name is mapped from `order_sales_channel` (e.g. `"Lowes"` is mapped to `"Lowe's"`). The result is joined to daily data on `retailer`, `item_id`, and `DATE_TRUNC(date, MONTH)`.

**NULL rates for `est_cost`:** Lowe's has the highest NULL rate (76%) because many items lack sufficient wholesale sales history. Walmart has ~6% NULL, Target ~8%, West Marine ~41%.

**Product ID recovery logic (for NULL RTIC IDs):**

Some Alloy product rows arrive with a NULL `RTIC ID`. The view recovers these by matching on `Walmart Prime Item Nbr`:

1. Identify product rows where `RTIC ID IS NULL`
2. Find sibling product rows that share the same `Walmart Prime Item Nbr` AND have a non-NULL `RTIC ID`
3. Inherit the RTIC ID, description, Target/Lowe's/West Marine identifiers from the sibling row
4. UNION ALL with the remaining products that already have a valid `RTIC ID`

This recovers most NULL-ID products. After recovery, only ~4,824 rows remain with NULL `item_id` (~0.005% of total).

**Channel derivation logic:**

The `channel` column is derived in this priority order:
1. If the Alloy `POS Channel` field is populated, use it directly (either `In-store` or `e-Commerce`)
2. Else if `location_type = 'Distribution Center'`, set to `e-Commerce`
3. Else default to `In-store`

**West Marine geo data:**

West Marine locations are missing geographic data (state, zip, city, lat/long) in the Alloy location feed. The view falls back to `retail.stores_realized` (joined on `store_number = location_number` WHERE `retailer = 'West Marine'`) for these fields.

**Notes:**
- `item_id` is STRING — always `SAFE_CAST(item_id AS INT64)` before joining to `analytics.items` or any other table
- `Lowe's` uses a curly apostrophe in the data — filter as `WHERE retailer = 'Lowe''s'` in SQL
- Rows only exist when there is activity: `inventory_units <> 0 OR units_gross <> 0 OR return_sales <> 0` — zero-activity days are excluded
- `est_cost` is the wholesale price RTIC charges the retailer, not COGS. Use it to estimate RTIC revenue from retail sell-through: `units_net * est_cost`
- `channel = 'e-Commerce'` rows are Distribution Center rows (retailer fulfills online orders from DC inventory); `channel = 'In-store'` rows are physical store locations
- `Address1` is NULL for all West Marine rows and ~49K Walmart rows
- Category columns (`category1`, `category2`, `category3`) are derived by splitting `analytics.items.category_path` on `>` and selecting the last 3 levels (with logic to skip the leading `RTIC` brand prefix when the path has 4+ levels). NULL when `item_id` is NULL or the item is not found in `analytics.items`.

**Common query patterns:**

```sql
-- Retail POS sales by retailer and week
SELECT
  DATE_TRUNC(date, WEEK) AS week,
  retailer,
  SUM(units_net) AS units,
  SUM(sales_net) AS pos_sales,
  SUM(units_net * est_cost) AS est_rtic_revenue
FROM retail.daily
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 13 WEEK)
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC

-- Store-level performance: stores with inventory, stores with sales, AUR
SELECT
  d.retailer,
  SAFE_CAST(d.item_id AS INT64) AS item_id,
  i.parentName,
  SUM(d.units_net) AS net_units,
  SUM(d.sales_net) AS net_sales,
  SAFE_DIVIDE(SUM(d.sales_net), SUM(d.units_net)) AS aur,
  COUNT(DISTINCT IF(d.inventory_units > 0 OR d.sales_gross > 0, d.location_number, NULL)) AS stores_with_inventory,
  COUNT(DISTINCT IF(d.sales_gross > 0, d.location_number, NULL)) AS stores_with_sales
FROM retail.daily d
JOIN analytics.items i ON i.id = SAFE_CAST(d.item_id AS INT64)
WHERE d.date >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
GROUP BY 1, 2, 3
ORDER BY net_units DESC

-- Current retail inventory on hand by retailer
SELECT
  retailer,
  SAFE_CAST(item_id AS INT64) AS item_id,
  title,
  SUM(inventory_units) AS total_inventory_units,
  COUNT(DISTINCT location_number) AS stocking_locations
FROM retail.daily
WHERE date = '2026-04-06'  -- use latest available date
  AND inventory_units > 0
GROUP BY 1, 2, 3
ORDER BY 1, total_inventory_units DESC

-- Return rate by retailer
SELECT
  retailer,
  SUM(units_gross) AS gross_units,
  SUM(return_units) AS return_units,
  ROUND(SAFE_DIVIDE(SUM(return_units), SUM(units_gross)), 4) AS return_rate,
  SUM(sales_gross) AS gross_sales,
  SUM(return_sales) AS return_sales,
  ROUND(SAFE_DIVIDE(SUM(return_sales), SUM(sales_gross)), 4) AS dollar_return_rate
FROM retail.daily
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 52 WEEK)
GROUP BY 1
ORDER BY gross_units DESC
```



---

### `marketing.marketing_metrics`

**What it is:** A daily marketing performance table that blends three data sources into a single unified view: (1) sales/transactions from `analytics.item_metrics`, (2) web sessions from `marketing.ga_sessions`, and (3) ad spend/cost from `marketing.marketing_cost`. One row per date × marketing dimension combination (business, sales channel, platform, media type, marketing channel, campaign, campaign group, campaign type, source, medium). Built by a scheduled query ("Marketing Metrics V3") that runs daily and does a `CREATE OR REPLACE TABLE`. ~1.68M rows from July 2015 to present.

**How it is built:** The scheduled query performs a FULL OUTER JOIN across three CTEs on all 11 dimension columns (date, business, sales_channel, platform, media_type, marketing_channel, campaign, campaign_group, campaign_type, source, medium):
- **`orders` CTE** — aggregates `analytics.item_metrics` for transactions, sales, net_margin, new buyers, and phone/bulk breakouts. Excludes retail partner sales (`order_sub_sales_channel NOT LIKE '%Retail%'`).
- **`sessions` CTE** — aggregates `marketing.ga_sessions` for web visit counts. Hardcoded to `business = 'RTIC'`, `sales_channel = 'Web'`.
- **`cost` CTE** — aggregates `marketing.marketing_cost` for ad spend, impressions, email sends/opens.

Because of the FULL OUTER JOIN, a row can have cost data but no sales (e.g., PDM), sales but no cost (e.g., Direct, Organic Search), or visits but neither cost nor sales. NULL metric values mean that data source had no matching row for that dimension combination.

**Row count:** ~1,683,094

**Date range:** 2015-07-28 to present (updated daily)

| column | type | notes |
|---|---|---|
| date | DATE | Calendar date |
| business | STRING | Business entity: `RTIC`, `BottleKeeper`, `Cuero` |
| sales_channel | STRING | Sales channel (mapped from `order_new_sales_channel` in item_metrics) |
| platform | STRING | Ad/traffic platform |
| media_type | STRING | Media type classification |
| marketing_channel | STRING | Standardized marketing channel — **primary grouping dimension for channel-level reporting** |
| campaign | STRING | Campaign name |
| campaign_group | STRING | Campaign group classification |
| campaign_type | STRING | Campaign type classification |
| source | STRING | UTM source / traffic source |
| medium | STRING | UTM medium / traffic medium |
| messages_sent | INT64 | Email/SMS messages sent (from `marketing.marketing_cost`); NULL when no cost data exists for the row |
| email_opens | INT64 | Email opens (from `marketing.marketing_cost`); NULL when no cost data |
| cost | FLOAT64 | Marketing spend in USD (from `marketing.marketing_cost`); NULL for organic/unpaid channels |
| impressions | INT64 | Ad impressions (from `marketing.marketing_cost`); NULL for non-paid or non-impression channels |
| visits | INT64 | Web sessions (from `marketing.ga_sessions`); NULL for non-web channels like Amazon, Phone, Retail, Customization |
| transactions | INT64 | Order count = `COUNT(DISTINCT order_id)` from item_metrics; NULL when no orders match the dimension combination |
| sales | FLOAT64 | Total revenue = `SUM(sales)` from item_metrics; NULL when no orders |
| net_margin | FLOAT64 | Net margin = `SUM(net_margin)` from item_metrics; NULL when no orders |
| transactions_phone_bulk | INT64 | Orders where `order_sub_sales_channel = 'Phone Bulk'` — subset of `transactions` for separating phone/bulk if needed |
| sales_phone_bulk | FLOAT64 | Sales from Phone Bulk orders — subset of `sales` |
| net_margin_phone_bulk | FLOAT64 | Net margin from Phone Bulk orders — subset of `net_margin` |
| new_buyers | INT64 | First-time buyers = orders where `order_number = 1`; subset of `transactions` |
| new_buyer_sales | FLOAT64 | Sales from first-time buyers |
| buyers | INT64 | Distinct customer count = `COUNT(DISTINCT customer_id)` from item_metrics |

**Categorical values for `business`:**

| value | row count |
|---|---|
| RTIC | ~1,595,700 |
| BottleKeeper | ~78,300 |
| Cuero | ~9,100 |

**Categorical values for `sales_channel`:**

| value | row count | notes |
|---|---|---|
| Web | ~1,452,300 | D2C web sales + GA sessions + ad cost — dominant channel |
| Amazon | ~187,500 | Amazon marketplace |
| Bulk | ~36,100 | B2B/wholesale (mapped from item_metrics `order_new_sales_channel`) |
| Customization | ~3,200 | Custom Shop / ASI |
| Retail | ~2,600 | Non-partner retail (partner retail is excluded from this table) |
| Dropship | ~1,300 | Dropship orders |

**Categorical values for `media_type`:**

| value | row count | notes |
|---|---|---|
| Paid Media | ~398,500 | Google, Meta, Bing, TikTok, Pinterest, etc. |
| Email | ~362,800 | Klaviyo + other ESPs |
| Organic | ~283,800 | Organic search, free social, direct |
| Marketplace | ~183,900 | Amazon |
| SMS | ~153,800 | Attentive |
| Affiliate | ~136,900 | AvantLink, Impact, etc. |
| Unknown | ~59,800 | Unclassified |
| Direct | ~57,500 | Direct traffic |
| Refer-a-friend | ~16,300 | Talkable |
| QR Code | ~12,200 | QR code scans |
| EMail | ~9,300 | Alternate email source (note capitalization differs from `Email`) |
| Referral | ~5,300 | Referral traffic |
| PDM | ~2,200 | Power Digital Marketing |
| Loyalty | ~875 | Yotpo loyalty |

**Categorical values for `marketing_channel` (with data availability):**

| value | has cost? | has visits? | has transactions? | notes |
|---|---|---|---|---|
| Meta | Yes | Yes | Yes | Facebook & Instagram paid |
| Paid Shopping | Yes | Yes | Yes | Google Shopping ads |
| [Amazon] | Yes | No | Yes | Amazon Advertising + marketplace sales; no GA visits |
| Paid Search | Yes | Yes | Yes | Google/Bing search ads |
| Display / Video | Yes | Yes | Yes | Programmatic display, YouTube |
| Affiliates | Yes | Yes | Yes | AvantLink, Impact, etc. |
| SMS | Yes | Yes | Yes | Attentive; cost = platform fee |
| TikTok | Yes | Yes | Yes (few) | TikTok ads |
| PDM | Yes | No | No | Power Digital Marketing agency fee; cost only, no attributed sales |
| Email | Yes | Yes | Yes | Klaviyo + other ESPs; cost = platform fee |
| Direct | No | Yes | Yes | Direct type-in / bookmark traffic |
| Organic Search | No | Yes | Yes | Google/Bing organic search |
| Free Social | No | Yes | Yes | Organic social media |
| Referral | No | Yes | Yes | Third-party referral sites |
| Refer-a-friend | No | Yes | Yes | Talkable referral program |
| QR Code | No | Yes | Yes (few) | QR code scans |
| Narvar | No | Yes | Yes | Post-purchase tracking page clicks |
| Unknown | No | Yes | Yes | Unclassified traffic |
| Loyalty | No | Yes | Yes (few) | Yotpo loyalty |

**Categorical values for `platform`** (top values):

| value | row count |
|---|---|
| Klaviyo | ~325,800 |
| Google | ~197,000 |
| Referral | ~189,000 |
| Meta | ~184,900 |
| Amazon | ~183,900 |
| Attentive | ~147,300 |
| AvantLink | ~93,700 |
| Unknown | ~59,800 |
| Direct | ~57,500 |
| Impact | ~43,200 |
| Bing | ~41,800 |
| Other ESP | ~39,200 |
| Talkable | ~16,300 |
| TikTok | ~13,900 |

**FY25 channel-level benchmarks (Apr 2025 – Mar 2026):**

| marketing_channel | cost | sales | ROAS | transactions | new_buyers |
|---|---|---|---|---|---|
| Meta | $8.3M | $6.0M | 0.72 | 69,640 | 40,955 |
| Paid Shopping | $5.1M | $12.5M | 2.45 | 100,837 | 61,576 |
| [Amazon] | $2.5M | $36.4M | 14.51 | 494,649 | 494,649 |
| Paid Search | $2.4M | $12.3M | 5.13 | 89,423 | 43,624 |
| Display / Video | $1.2M | $214K | 0.18 | 1,879 | 1,298 |
| Affiliates | $705K | $9.6M | 13.58 | 66,888 | 33,154 |
| SMS | $532K | $3.8M | 7.20 | 37,051 | 14,031 |
| TikTok | $398K | $129K | 0.32 | 1,473 | 900 |
| PDM | $266K | — | — | — | — |
| Email | $179K | $6.5M | 36.48 | 51,478 | 12,525 |
| Direct | — | $24.1M | — | 226,077 | 80,913 |
| Organic Search | — | $8.9M | — | 68,252 | 35,538 |

**Phone/Bulk columns:**
- `transactions_phone_bulk`, `sales_phone_bulk`, and `net_margin_phone_bulk` are **subsets** of the main `transactions`, `sales`, and `net_margin` columns — they isolate orders where `order_sub_sales_channel = 'Phone Bulk'`
- These are NOT additive to the main metrics — they are already included in `transactions`/`sales`/`net_margin`
- Use them to separate or exclude phone bulk orders: `sales - sales_phone_bulk` = non-phone-bulk sales

**Key exclusion:** Retail partner sales (Walmart, Target, Lowe's, West Marine) are **excluded** from this table. The scheduled query filters `WHERE order_sub_sales_channel NOT LIKE '%Retail%'`. Use `retail.daily` for retail partner POS data.

**Notes:**
- Dimension values default to `"Unknown"` via COALESCE when all three source CTEs have NULL for that dimension — there are no true NULLs in dimension columns
- `visits` comes from `marketing.ga_sessions` which only covers web traffic — Amazon, Phone, Retail, and Customization channels will always have NULL visits
- `cost` for Email and SMS represents platform fees (Klaviyo, Attentive), not media spend
- `cost` for PDM is an agency fee with no directly attributed sales or visits
- Amazon `new_buyers` equals `transactions` because Amazon does not share customer history — every Amazon order is treated as `order_number = 1`
- Meta ROAS appears low (~0.72) because `sales` only counts last-touch attributed orders from item_metrics; Meta's value is largely upper-funnel awareness driving conversions attributed to other channels
- `media_type` has both `Email` and `EMail` (different capitalizations) — use `marketing_channel` for cleaner grouping
- The table is rebuilt daily from scratch (`CREATE OR REPLACE TABLE`), not incrementally updated
- For ROAS calculations: `SAFE_DIVIDE(SUM(sales), NULLIF(SUM(cost), 0))`
- For conversion rate: `SAFE_DIVIDE(SUM(transactions), SUM(visits))` — only meaningful for web-based channels with visits

**Common query patterns:**

```sql
-- Daily marketing spend and ROAS by channel
SELECT
  date,
  marketing_channel,
  SUM(cost) AS cost,
  SUM(sales) AS sales,
  ROUND(SAFE_DIVIDE(SUM(sales), NULLIF(SUM(cost), 0)), 2) AS roas,
  SUM(visits) AS visits,
  SUM(transactions) AS transactions,
  ROUND(SAFE_DIVIDE(SUM(transactions), NULLIF(SUM(visits), 0)), 4) AS cvr
FROM marketing.marketing_metrics
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND business = 'RTIC'
GROUP BY 1, 2
ORDER BY 1, 3 DESC NULLS LAST

-- Weekly marketing efficiency (paid channels only)
SELECT
  DATE_TRUNC(date, WEEK) AS week,
  marketing_channel,
  ROUND(SUM(cost), 0) AS cost,
  ROUND(SUM(sales), 0) AS sales,
  ROUND(SAFE_DIVIDE(SUM(sales), NULLIF(SUM(cost), 0)), 2) AS roas,
  ROUND(SAFE_DIVIDE(SUM(cost), NULLIF(SUM(transactions), 0)), 2) AS cpa
FROM marketing.marketing_metrics
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 13 WEEK)
  AND cost > 0
GROUP BY 1, 2
ORDER BY 1, 3 DESC

-- New buyer acquisition by channel
SELECT
  marketing_channel,
  SUM(new_buyers) AS new_buyers,
  ROUND(SUM(new_buyer_sales), 0) AS new_buyer_sales,
  ROUND(SAFE_DIVIDE(SUM(cost), NULLIF(SUM(new_buyers), 0)), 2) AS cac
FROM marketing.marketing_metrics
WHERE date BETWEEN '2025-04-01' AND '2026-03-31'
  AND business = 'RTIC'
GROUP BY 1
HAVING SUM(new_buyers) > 0
ORDER BY new_buyers DESC

-- Total marketing P&L: cost vs attributed margin
SELECT
  DATE_TRUNC(date, MONTH) AS month,
  ROUND(SUM(cost), 0) AS total_cost,
  ROUND(SUM(sales), 0) AS total_sales,
  ROUND(SUM(net_margin), 0) AS total_net_margin,
  ROUND(SUM(net_margin) - SUM(cost), 0) AS margin_after_marketing
FROM marketing.marketing_metrics
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
  AND business = 'RTIC'
GROUP BY 1
ORDER BY 1
```



---

### `marketing.ga4_sessions`

**What it is:** One row per GA4 web session. Built daily by a scheduled query from raw GA4 events (`marketing.ga4_data`), enriched with custom channel classification (`marketing.channel_mapping`), page-level product/order context, cart contents, and A/B test assignments. ~90.8M sessions total from April 2023 to present. Updated daily.

**Source tables:**
- `marketing.ga4_data` — raw GA4 BigQuery export (events table)
- `marketing.channel_mapping` — custom lookup that maps source/medium/campaign → platform, channel, campaign type
- `c2s_public.item_types` + `marketing.path_type_history` — maps URL paths to product types
- `analytics.item_metrics` + `analytics.items` — enriches page views with attributed sales/margin
- `marketing.ab_sessions` — A/B test session assignments

**Granularity:** One row = one GA4 session. A user (`user_pseudo_id`) can have many sessions across multiple dates.

**Key identifiers:**

| column | type | notes |
|---|---|---|
| `session_id` | STRING | Unique session key = `user_pseudo_id` + `ga_session_id` concatenated |
| `user_pseudo_id` | STRING | GA4 anonymous user identifier (cookie-based) |
| `ga_session_id` | INT64 | Numeric session counter within a user |
| `date` | DATE | Session date (local) |
| `transaction_id` | STRING | GA4 ecommerce order ID — links to `c2s_public.orders.unique_id` for converting sessions; NULL if no purchase |

**Traffic source (attribution):**

GA4 uses **last non-direct click** attribution at the session level (`session_traffic_source_last_non_direct`). The raw source/medium/campaign are then run through a custom channel mapping table to produce standardized channel fields.

| column | type | notes |
|---|---|---|
| `source_medium` | STRING | Raw GA4 `source / medium` (e.g., `google / cpc`, `(direct) / (none)`) |
| `original_campaign` | STRING | Raw GA4 campaign name — always use this when filtering by specific campaign names |
| `source` | STRING | Source after channel mapping override |
| `medium` | STRING | Medium after channel mapping override |
| `campaign` | STRING | Campaign after channel mapping override |
| `platform` | STRING | Ad platform (e.g., `Google`, `Meta`, `Bing`, `Direct`) |
| `media_type` | STRING | Media type (e.g., `Paid Media`, `Email`, `SMS`, `Organic`, `Direct`) |
| `marketing_channel` | STRING | Standardized channel (e.g., `Paid Search`, `Meta`, `Email`, `Direct`, `Organic Search`, `Affiliates`) |
| `campaign_type` | STRING | Campaign type classification (e.g., `Conversion`, `Branded Search`, `Broadcast`, `Automated`) |
| `campaign_group` | STRING | Campaign group classification |
| `channel_mapping_rule` | INT64 | Which rule number in `channel_mapping` matched this session — useful for debugging misclassifications |
| `ad_content` | STRING | Ad content / creative identifier |
| `keyword` | STRING | Search keyword (for paid search sessions) |

**Session metrics:**

| column | type | notes |
|---|---|---|
| `new_visits` | INT64 | 1 if `first_visit` or `first_open` event fired (new user to the site) |
| `pageviews` | INT64 | Count of `page_view` events in the session |
| `is_bounce` | BOOL | TRUE if `pageviews <= 1` |
| `is_engaged` | BOOL | TRUE if any event had GA4's `session_engaged = 1` flag |
| `includes_checkout_page` | BOOL | TRUE if any page URL contained `/checkout` |
| `includes_cart_page` | BOOL | TRUE if any page URL contained `/cart` |
| `custom_shop_quote_submitted` | BOOL | TRUE if `customization_form_submission` event fired (Custom Shop B2B inquiry) |
| `total_units_in_cart` | INT64 | Total units added to cart during the session (sum of all `add_to_cart` event quantities) |
| `session_start` | TIMESTAMP | Timestamp of first event in the session |
| `session_end` | TIMESTAMP | Timestamp of last event in the session |
| `landing_page_path` | STRING | First page URL of the session (from `session_start` event) |

**Transaction / revenue:**

| column | type | notes |
|---|---|---|
| `transactions` | INT64 | 1 if a GA4 `purchase` event fired, else 0 |
| `transaction_revenue` | FLOAT64 | GA4-reported purchase revenue — may differ slightly from `analytics.item_metrics` totals |

**Device:**

| column | type | notes |
|---|---|---|
| `device_category` | STRING | `mobile`, `desktop`, `tablet`, `smart tv` |
| `device_browser` | STRING | Browser name |
| `device_browser_version` | STRING | Browser version string |
| `device_mobile_brand_name` | STRING | Phone manufacturer (e.g., `Samsung`, `Apple`) |
| `device_mobile_model_name` | STRING | Phone model |
| `operating_system` | STRING | OS name (e.g., `Android`, `iOS`, `Windows`) |

**REPEATED (array) columns:**

| column | notes |
|---|---|
| `items_in_cart` | One struct per unique item added to cart during the session. Fields: `item_id` (STRING), `quantity` (INT64), `price` (FLOAT64). From `add_to_cart` events — shows intent, not necessarily purchase. |
| `ab_tests` | One struct per A/B test this session was enrolled in. Fields: `campaign` (test name), `variant` (e.g., `Control`, `Treatment`). Only populated if the session was in a test tracked via `marketing.ab_sessions`. |
| `pages` | One struct per `page_view` event in the session, ordered by `seq`. See fields below. |

**`pages` array fields (one element per page view):**

| field | type | notes |
|---|---|---|
| `timestamp` | TIMESTAMP | When this page was viewed |
| `seq` | INT64 | Page sequence number within the session (1 = landing page) |
| `path` | STRING | Cleaned/extracted page path (e.g., `Road-Trip-Tumblers`, `checkout`, `[Home Page]`) |
| `page_location` | STRING | Full URL including query params |
| `item_type` | STRING | Product type if this is a PDP (e.g., `Road Trip Tumbler`) — from `c2s_public.item_types` |
| `category1` | STRING | Planning group category for the product type (e.g., `Drinkware`, `Hard Coolers`) |
| `category2` | STRING | Planning group name |
| `sales` | FLOAT64 | Revenue attributed to this page in the session — only populated on the last visit to a given page type in a converting session, to prevent double-counting |
| `gross_margin` | FLOAT64 | Gross margin attributed to this page view |
| `units` | FLOAT64 | Units attributed to this page view |
| `myrtic` | BOOL | TRUE if the purchased item was a myRTIC customization |
| `is_enter` | BOOL | TRUE if this was the first page of the session (landing page) |
| `is_exit` | BOOL | TRUE if this was the last page of the session |
| `is_custom_pdp` | BOOL | TRUE if URL contained `custom=true` (custom color/design PDP variant) |
| `is_myrtic_designer` | BOOL | TRUE if URL contained `design=true` (myRTIC designer tool page) |
| `color` | STRING | Color extracted from URL param `?color=` on PDPs |
| `size` | STRING | Size extracted from URL param `?size=` on PDPs |
| `referrer` | STRING | Referring URL for this specific page view |

**Scale and channel benchmarks (CY2025):**

| marketing_channel | sessions | CVR | revenue |
|---|---|---|---|
| Direct | 8.6M | 1.82% | $34.1M |
| Meta | 7.5M | 0.69% | $4.8M |
| Paid Shopping | 2.8M | 2.77% | $12.1M |
| Email | 2.6M | 1.76% | $9.7M |
| SMS | 2.0M | 1.42% | $3.3M |
| Paid Search | 1.8M | 3.90% | $12.8M |
| Organic Search | 1.5M | 3.13% | $9.1M |
| Affiliates | 656K | 7.19% | $8.3M |
| TikTok | 480K | 0.30% | $135K |
| Free Social | 277K | 0.87% | $317K |
| Display / Video | 122K | 1.31% | $240K |
| Referral | 110K | 6.70% | $1.6M |

**Device CVR (CY2025):** Desktop 2.84% >> Tablet 1.74% ~ Mobile 1.67% >> Smart TV 0.45%

**Categorical values for `platform`** (top values, 2025+):
`Direct` (10.1M), `Meta` (9.2M), `Google` (7.0M), `Klaviyo` (4.0M), `Attentive` (1.3M), `Impact` (730K), `TikTok` (492K), `Bing` (331K), `Referral` (128K), `YouTube` (126K), `DuckDuckGo` (76K), `Narvar` (68K)

**Categorical values for `media_type`** (2025+):
`Paid Media` (15.0M), `Direct` (10.1M), `Email` (2.95M), `SMS` (2.4M), `Organic` (2.3M), `Affiliate` (731K), `QR Code` (42K), `Unknown` (38K), `Refer-a-friend` (18K)

**NULL rates (2025+ data, 33.6M sessions):**
- `marketing_channel`: 0 NULLs (every session gets a channel)
- `transaction_id`: 33.0M NULLs (~98% — only converting sessions have a transaction_id)
- `landing_page_path`: 6.9M NULLs (~21% — sessions that start without a `session_start` event with page_location)

**A/B test coverage (2025+):** 7.4M sessions (22%) have at least one A/B test assignment.

**Cart activity (2025+):** 1.7M sessions (5%) added items to cart; 1.9M (5.6%) visited the cart page; 1.9M (5.6%) reached checkout; 3,114 submitted a Custom Shop quote.

**Notes:**
- `original_campaign` is the raw GA4 campaign name — always use this when filtering by specific campaign names (e.g., for A/B test analysis). `campaign` may be overridden by channel_mapping.
- `transaction_revenue` comes from GA4 ecommerce and can differ from `analytics.item_metrics` revenue due to GA4 deduplication, refunds, or client-side tracking gaps. For financial reporting, prefer `analytics.item_metrics`.
- `transaction_id` joins to `c2s_public.orders.unique_id` (not `order_id`) — it is the external/GA4 order ID, not the internal integer order ID
- `pages[].sales` is only populated for converting sessions and uses last-visit-wins logic per page type to avoid double-counting when a user visits the same product page multiple times
- `is_bounce = TRUE` means <= 1 pageview — does NOT mean the user left immediately; they may have been engaged (watched a video, scrolled) without triggering a second page_view
- The `channel_mapping_rule` value 93 = Direct (largest group); use this field to investigate unexpected channel classifications
- Table is large (~90.8M rows); always filter by `date` range for performance
- `marketing.ga_sessions` is a downstream table that merges `ga4_sessions` with older Universal Analytics data — use `ga4_sessions` directly for GA4-era analysis (April 2023+)

**Common query patterns:**

```sql
-- Session-level conversion rate by channel
SELECT
  marketing_channel,
  COUNT(*) AS sessions,
  COUNTIF(transactions > 0) AS converting_sessions,
  ROUND(SAFE_DIVIDE(COUNTIF(transactions > 0), COUNT(*)), 4) AS cvr,
  ROUND(SUM(transaction_revenue), 0) AS revenue
FROM marketing.ga4_sessions
WHERE date BETWEEN '2025-01-01' AND '2025-12-31'
GROUP BY 1
ORDER BY sessions DESC

-- Pages viewed in converting sessions (what product pages drive sales)
SELECT
  p.item_type,
  p.category1,
  COUNT(DISTINCT s.session_id) AS sessions,
  SUM(p.sales) AS attributed_sales
FROM marketing.ga4_sessions s, UNNEST(pages) p
WHERE s.date >= '2025-01-01'
  AND s.transactions > 0
  AND p.sales > 0
GROUP BY 1, 2
ORDER BY attributed_sales DESC

-- Cart abandonment: sessions that added to cart but did not convert
SELECT
  marketing_channel,
  COUNT(*) AS cart_sessions,
  COUNTIF(transactions > 0) AS purchased,
  ROUND(SAFE_DIVIDE(COUNTIF(transactions = 0), COUNT(*)), 3) AS abandonment_rate
FROM marketing.ga4_sessions
WHERE date >= '2025-01-01'
  AND ARRAY_LENGTH(items_in_cart) > 0
GROUP BY 1
ORDER BY cart_sessions DESC

-- A/B test variant session counts
SELECT
  ab.campaign,
  ab.variant,
  COUNT(*) AS sessions,
  COUNTIF(transactions > 0) AS converting_sessions,
  ROUND(SAFE_DIVIDE(COUNTIF(transactions > 0), COUNT(*)), 4) AS cvr,
  ROUND(SUM(transaction_revenue), 2) AS revenue
FROM marketing.ga4_sessions s, UNNEST(ab_tests) ab
WHERE s.date BETWEEN '2026-02-17' AND '2026-03-16'
GROUP BY 1, 2
ORDER BY 1, 2
```



---

## How to Join These Tables

### Primary join key: `item_id`

All tables share `item_id` as the universal item identifier. The mapping is:

| Table | Column name |
|---|---|
| `inventory.inventory_daily` | `item_id` (also `sku` — same value) |
| `analytics.item_metrics` | `item_id` |
| `analytics.items` | `id` |
| `replen.demand_forecast_items_latest` | `item_id` |
| `inventory.inventory_metrics_item_daily` | `item_id` |
| `replen.po_status` | `item_id` |
| `operations.receipts` | `item_id` |
| `marketing.marketing_metrics` | (no item_id — keyed by marketing dimensions) |
| `retail.daily` | `item_id` (STRING — must SAFE_CAST to INT64) |

**Joining `analytics.items` to any other table:**
```sql
JOIN analytics.items i ON i.id = im.item_id
```

### Linking POs to Receipts

```sql
-- receipts back to PO status
JOIN replen.po_status pos ON pos.forecast_id = r.forecast_id
```

### Join caveats

**`inventory.inventory_daily` — always filter to a date:**
The table has millions of rows across all historical dates. Always add a date filter to avoid full scans:
```sql
WHERE date = CURRENT_DATE('America/Los_Angeles')
```

**`analytics.item_metrics` — one row per order line, not per item:**
Aggregating sales by item requires `GROUP BY item_id` and `SUM(base_quantity)`, `SUM(sales)`, etc.

**`inventory.inventory_daily` × `analytics.item_metrics` — no direct date join:**
These tables do not join on date. Inventory is a daily snapshot; sales are order-level events. To combine them, aggregate each separately and join on `item_id`:
```sql
WITH inv AS (
  SELECT item_id, SUM(available_units) AS available_units
  FROM inventory.inventory_daily
  WHERE date = CURRENT_DATE('America/Los_Angeles')
    AND location_type IN ('warehouse', 'customization')
  GROUP BY item_id
),
sales AS (
  SELECT item_id, SUM(base_quantity) AS units_sold_28d
  FROM analytics.item_metrics
  WHERE CAST(order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 28 DAY)
  GROUP BY item_id
)
SELECT i.parentName, inv.available_units, sales.units_sold_28d
FROM analytics.items i
JOIN inv ON inv.item_id = i.id
LEFT JOIN sales ON sales.item_id = i.id
WHERE NOT i.is_inactive
```

**`replen.demand_forecast_items_latest` — weekly granularity:**
Forecast rows are one per item per week. To get total forecasted demand over a horizon:
```sql
WHERE CAST(date AS DATE) BETWEEN CURRENT_DATE() AND DATE_ADD(CURRENT_DATE(), INTERVAL 12 WEEK)
```

**`replen.po_status` — may have multiple versions per PO:**
`version_index = 0` is the original version. Filter to the latest or original as needed. Multiple rows can exist per `forecast_id` if items have been revised.

**`replen.po_status` ARRAY columns require UNNEST:**
```sql
SELECT pos.forecast_id, pos.item_id, cd.container_number, cd.delivery_date, cd.route
FROM replen.po_status pos
CROSS JOIN UNNEST(pos.container_detail) AS cd
WHERE NOT pos.closed
```

---

## Common Query Patterns

### 1. Current inventory snapshot by product

Get current warehouse inventory for all active RTIC items:

```sql
SELECT
  i.parentName,
  i.planning_group_category,
  SUM(inv.available_units) AS available_units,
  SUM(inv.total_units) AS total_units,
  SUM(inv.total_value) AS total_value,
  AVG(inv.avg_unit_value) AS avg_unit_cost,
  MAX(inv.safety_stock) AS safety_stock
FROM inventory.inventory_daily inv
JOIN analytics.items i ON i.id = inv.item_id
WHERE inv.date = CURRENT_DATE('America/Los_Angeles')
  AND inv.location_type IN ('warehouse', 'customization')
  AND inv.business = 'RTIC'
  AND NOT i.is_inactive
GROUP BY 1, 2
ORDER BY available_units DESC
```

### 2. Inventory below safety stock

Items where current available inventory is below the safety stock level:

```sql
SELECT
  inv.title,
  inv.available_units,
  inv.safety_stock,
  inv.available_units - inv.safety_stock AS buffer,
  inv.total_value
FROM inventory.inventory_daily inv
WHERE inv.date = CURRENT_DATE('America/Los_Angeles')
  AND inv.location_type IN ('warehouse', 'customization')
  AND inv.safety_stock IS NOT NULL
  AND inv.available_units < inv.safety_stock
ORDER BY (inv.available_units - inv.safety_stock) ASC
```

### 3. Weekly sales velocity by item

Calculate recent sales velocity to inform replenishment decisions:

```sql
SELECT
  im.item_id,
  i.parentName,
  i.variantName,
  SUM(im.base_quantity) AS units_sold,
  SUM(im.base_quantity) / 8.0 AS weekly_velocity,
  SUM(im.sales) AS revenue
FROM analytics.item_metrics im
JOIN analytics.items i ON i.id = im.item_id
WHERE CAST(im.order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
  AND im.order_sales_channel IN ('Web', 'Amazon')
  AND im.order_business = 'RTIC'
GROUP BY 1, 2, 3
ORDER BY weekly_velocity DESC
```

### 4. Inventory vs. demand forecast — weeks of supply

Calculate weeks of supply remaining based on current inventory and forecasted demand:

```sql
WITH current_inv AS (
  SELECT item_id, SUM(available_units) AS available_units
  FROM inventory.inventory_daily
  WHERE date = CURRENT_DATE('America/Los_Angeles')
    AND location_type IN ('warehouse', 'customization')
  GROUP BY item_id
),
weekly_demand AS (
  SELECT item_id, AVG(d2c_units + b2b_units) AS avg_weekly_demand
  FROM replen.demand_forecast_items_latest
  WHERE CAST(date AS DATE) BETWEEN CURRENT_DATE() AND DATE_ADD(CURRENT_DATE(), INTERVAL 12 WEEK)
  GROUP BY item_id
)
SELECT
  i.parentName,
  i.variantName,
  inv.available_units,
  ROUND(wd.avg_weekly_demand, 1) AS weekly_demand_forecast,
  ROUND(SAFE_DIVIDE(inv.available_units, wd.avg_weekly_demand), 1) AS weeks_of_supply
FROM analytics.items i
JOIN current_inv inv ON inv.item_id = i.id
JOIN weekly_demand wd ON wd.item_id = i.id
WHERE NOT i.is_inactive
  AND wd.avg_weekly_demand > 0
ORDER BY weeks_of_supply ASC
```

### 5. Open POs with OTW units and expected arrival

Get all open POs with units currently on the water:

```sql
SELECT
  pos.forecast_id,
  pos.vendor,
  pos.parentName,
  pos.title,
  pos.item_id,
  pos.ship_date,
  pos.po_units,
  pos.received_units,
  pos.otw_units,
  pos.remaining_units,
  pos.first_otw_delivery_date,
  pos.last_otw_delivery_date,
  pos.is_late
FROM replen.po_status pos
WHERE NOT pos.closed
  AND pos.otw_units > 0
  AND pos.created > '2022-06-01'
ORDER BY pos.first_otw_delivery_date ASC
```

### 6. Recent receipts by item

What inventory actually arrived recently:

```sql
SELECT
  r.date,
  r.container_number,
  r.parentName,
  r.variantName,
  r.color,
  r.size,
  r.location,
  r.units_received,
  r.rate,
  r.units_received * r.rate AS receipt_value
FROM operations.receipts r
WHERE r.date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND r.units_received > 0
ORDER BY r.date DESC, r.container_number
```

### 7. Sales by category and channel

Revenue and margin by category, broken out by sales channel:

```sql
SELECT
  SPLIT(im.category_path, ' > ')[SAFE_OFFSET(1)] AS category_level1,
  im.order_sales_channel,
  COUNT(DISTINCT im.order_id) AS orders,
  SUM(im.base_quantity) AS units,
  SUM(im.sales) AS revenue,
  SUM(im.gross_margin) AS gross_margin,
  SAFE_DIVIDE(SUM(im.gross_margin), SUM(im.sales)) AS gm_rate
FROM analytics.item_metrics im
WHERE CAST(im.order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
  AND im.order_business = 'RTIC'
GROUP BY 1, 2
ORDER BY revenue DESC
```

### 8. Inventory value by category

Total on-hand inventory value broken down by top-level category:

```sql
SELECT
  SPLIT(inv.category_path, ' > ')[SAFE_OFFSET(1)] AS category,
  inv.location_type,
  SUM(inv.available_units) AS available_units,
  SUM(inv.total_value) AS total_value,
  SUM(inv.material_costs) AS material_costs
FROM inventory.inventory_daily inv
WHERE inv.date = CURRENT_DATE('America/Los_Angeles')
  AND inv.business = 'RTIC'
GROUP BY 1, 2
ORDER BY total_value DESC
```

### 9. Demand forecast totals by category, next 12 weeks

Total forecasted demand by category for planning purposes:

```sql
SELECT
  f.category1,
  f.category2,
  CAST(f.date AS DATE) AS forecast_week,
  SUM(f.d2c_units) AS d2c_units,
  SUM(f.b2b_units) AS b2b_units,
  SUM(f.d2c_units + f.b2b_units) AS total_units
FROM replen.demand_forecast_items_latest f
WHERE CAST(f.date AS DATE) BETWEEN CURRENT_DATE() AND DATE_ADD(CURRENT_DATE(), INTERVAL 12 WEEK)
GROUP BY 1, 2, 3
ORDER BY forecast_week, total_units DESC
```

### 10. Item-level sales trend (week over week)

Weekly sales by item for trending:

```sql
SELECT
  DATE_TRUNC(CAST(im.order_date AS DATE), WEEK) AS week,
  i.parentName,
  SUM(im.base_quantity) AS units,
  SUM(im.sales) AS revenue,
  SUM(im.net_margin) AS net_margin
FROM analytics.item_metrics im
JOIN analytics.items i ON i.id = im.item_id
WHERE CAST(im.order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 26 WEEK)
  AND im.order_sales_channel IN ('Web', 'Amazon')
  AND im.order_business = 'RTIC'
  AND i.parentName = '30oz Road Trip Tumbler'  -- replace with target product
GROUP BY 1, 2
ORDER BY 1, 3 DESC
```

### 11. New customer rate

Percentage of orders from new vs. returning customers:

```sql
SELECT
  DATE_TRUNC(CAST(order_date AS DATE), MONTH) AS month,
  COUNT(DISTINCT order_id) AS orders,
  COUNT(DISTINCT IF(order_number = 1, order_id, NULL)) AS new_customer_orders,
  SAFE_DIVIDE(COUNT(DISTINCT IF(order_number = 1, order_id, NULL)),
              COUNT(DISTINCT order_id)) AS new_customer_rate
FROM analytics.item_metrics
WHERE CAST(order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
  AND order_business = 'RTIC'
  AND order_sales_channel IN ('Web', 'Amazon')
GROUP BY 1
ORDER BY 1
```

### 12. Container-level receipt detail from PO status

Unpack the container_detail ARRAY to see container-level tracking:

```sql
SELECT
  pos.forecast_id,
  pos.parentName,
  pos.item_id,
  cd.container_number,
  cd.quantity,
  cd.delivery_date,
  cd.origin_port,
  cd.destination_port,
  cd.route,
  cd.via_dallas
FROM replen.po_status pos
CROSS JOIN UNNEST(pos.container_detail) AS cd
WHERE NOT pos.closed
  AND cd.delivery_date IS NOT NULL
ORDER BY cd.delivery_date ASC
```

---

## Business Concepts

### Inventory Value

`total_value` in `inventory.inventory_daily` = `material_costs` + (transportation/freight allocation). It is the fully-landed cost basis of inventory on hand. `material_costs` alone reflects just the product cost without freight. `avg_unit_value` is the per-unit average cost.

### Available Stock vs. Safety Stock

- `available_units` = units that can be sold (on_hand - committed - picked)
- `total_units` = on_hand - picked - committed (should equal `available_units` in most cases)
- `safety_stock` = the minimum buffer level the business wants to maintain; NULL for open box / clearance items
- **Buffer = `available_units - safety_stock`** — negative means below safety stock, a replenishment signal
- Filter to `location_type IN ('warehouse', 'customization')` for operational inventory (excludes retail and Amazon FBA)

### Reading `category_path`

The `category_path` column uses ` > ` as a delimiter and is structured hierarchically:
```
RTIC > Drinkware > Tumblers > Road Trip Tumbler
 ^       ^            ^              ^
brand  dept       sub-dept       product-line
```

Parse with `SPLIT(category_path, ' > ')`:
- `SPLIT(category_path, ' > ')[SAFE_OFFSET(0)]` → brand (`RTIC` or `Cuero`)
- `SPLIT(category_path, ' > ')[SAFE_OFFSET(1)]` → department (`Drinkware`, `Hard Coolers`, etc.)
- `SPLIT(category_path, ' > ')[SAFE_OFFSET(2)]` → sub-department
- `SPLIT(category_path, ' > ')[SAFE_OFFSET(3)]` → product line

Use `SAFE_OFFSET` instead of `OFFSET` to avoid errors when paths have fewer than expected levels.

Alternatively, `analytics.items` has pre-parsed `category1`, `category2`, `category3` columns, and `planning_group_category` is the recommended field for operational/replenishment category grouping.

### Demand Forecast

`replen.demand_forecast_items_latest` provides a weekly forward-looking demand forecast at the item level. The forecast is generated at the `forecast_unit` (parent product) level and then allocated down to individual items (`child_forecast_unit`) using historical demand mix percentages.

- `d2c_units` = direct-to-consumer (web/Amazon) expected weekly demand
- `b2b_units` = bulk/wholesale expected weekly demand
- Use `d2c_units + b2b_units` for total replenishment demand
- The forecast extends weekly to 2030, but practically 4–26 weeks ahead is relevant
- Filter `WHERE date > CURRENT_TIMESTAMP()` to get only future forecast weeks
- The most recent `created` date indicates the freshness of the forecast (currently refreshed ~weekly)

**Using forecast with inventory (weeks of supply):**
```
weeks_of_supply = available_units / avg_weekly_demand
```
A value under 4 weeks may trigger a replenishment review; under 2 weeks is urgent.

### PO Status and Incoming Inventory

`replen.po_status` tracks the lifecycle of purchase orders:
- `po_units` = total units ordered
- `received_units` = units already received at warehouse
- `otw_units` = units currently on shipping containers in transit
- `remaining_units` = units not yet shipped from vendor (still at factory; excludes OTW)
- `po_units - received_units` = units ordered but not yet received (= `remaining_units + otw_units`)
- `excess_units` = `po_units - received_units` — negative = over-received, positive = still outstanding
- `closed = FALSE` means the PO is still open/active
- `is_late = TRUE` means the expected delivery date has passed
- `ship_date` is the estimated factory departure date
- `first_otw_delivery_date` / `last_otw_delivery_date` are the estimated warehouse arrival window

For replenishment planning: filter `WHERE NOT closed AND po_units - received_units > 0` to see what is still incoming (includes both OTW and not-yet-shipped units).

### Receipts — Actual Inventory Received

`operations.receipts` is the historical record of inventory actually received. Unlike `replen.po_status` (which shows forecasted/expected), receipts shows what physically arrived:
- One row per item per container per receiving date
- `units_received = 0` rows may exist (container arrived but item had no physical receipt yet)
- Join back to `replen.po_status` using `forecast_id` to reconcile forecast vs. actual
- `rate` is the unit cost at time of receipt
- The `freight` STRUCT provides detailed landed cost breakdown: `freight.freight_base_per_unit`, `freight.duty_per_unit`, etc.

**Total landed cost per unit** = `rate` + `freight.freight_base_per_unit` + `freight.freight_assessorial_per_unit` + `freight.duty_per_unit`

### Sales Metrics Hierarchy

In `analytics.item_metrics`:
- `gross_sales` = list price × quantity
- `product_sales` = gross_sales - discounts
- `sales` = product_sales + shipping_paid + credits (primary revenue metric)
- `material_cost` = product cost
- `gross_margin` = product_sales - material_cost - amazon_fees - square_fees
- `net_margin` = gross_margin - shipping_cost - duties - other direct costs
- `base_quantity` = units sold (always use this, not `uom_quantity`)

### Key Identifiers Summary

- `item_id` / `analytics.items.id` — universal item/SKU key across all tables
- `forecast_id` — links `replen.po_status` to `operations.receipts`
- `order_id` — order key; one order has many `item_metrics` rows
- `orderitem_id` — unique row key in `item_metrics`
- `container_number` — physical container/shipment identifier
