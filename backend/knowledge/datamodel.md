# BQ Inventory Metrics

## BigQuery Project

- **Project:** `velky-brands`
- **Auth:** Application Default Credentials at `~/.config/gcloud/application_default_credentials.json`
- **Notebook magic:** `%%bigquery` via `bigquery_magics` extension
- **Timezone note:** The business operates in Central Time (America/Chicago). All TIMESTAMP columns in `analytics.item_metrics` (`order_date`, `fulfillment_date`, `delivery_date`, etc.) are stored in **Central Time** — use `TIME(CURRENT_DATETIME('America/Chicago'))` for time-of-day comparisons. `CAST(order_date AS DATE)` is already in CT with no conversion needed.
- **Current date:** 2026-03-16

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
| `retail.daily` | One row per date × retailer location × item — daily POS sales, returns, and on-hand inventory from Walmart, Target, Lowe's, and West Marine via Alloy data feed |

---

## Table Details

### `inventory.inventory_daily`

**What it is:** A daily snapshot view (one row per SKU × location × date) of inventory levels, values, and costs. This is a VIEW built on top of `c2s_stats.inventory` and `analytics.items`. Data goes back to at least 2022. As of 2026-03-16, the most recent snapshot date is 2026-03-16. Row count is in the tens of millions.

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
| page_title | STRING | Marketing page title; often NULL |
| type | STRING | Product type, e.g. `Compact Hard Sided Cooler` |
| vendor_name | STRING | Supplier/manufacturer name |
| total_units | FLOAT64 | Total units on hand (on_hand - picked - committed) |
| avaliable_units | FLOAT64 | **TYPO — do not use.** Misspelled duplicate of available_units |
| available_units | FLOAT64 | Units available — use this column, not `avaliable_units` |
| total_value | FLOAT64 | Total inventory value = material_costs + (transportation_avg × total_units) |
| avg_unit_value | FLOAT64 | Average cost per unit = total_value / total_units |
| material_costs | FLOAT64 | Material cost component of total_value |
| safety_stock | FLOAT64 | Target safety stock level; NULL for some items (open box / clearance) |

**Categorical values for `location_type`:**

| value | row count |
|---|---|
| warehouse | ~7.6M |
| retail | ~2.7M |
| amazon | ~141K |
| customization | ~122K |
| 3pl | ~82K |

**Known locations (`location_name`):**

| location_name | location_type | location_id |
|---|---|---|
| Katy HQ | warehouse | 20 |
| Gateway | warehouse | 8 |
| Retail, Houston | retail | 13 |
| Hempstead | warehouse | 14 |
| Amazon Warehouse (FBA) | amazon | — |
| Telge (Customization) | customization | — |
| RJW | 3pl | — |
| Remote Container Storage, Houston | warehouse | — |
| Hempstead Customization | customization | — |

**Categorical values for `business`:** `RTIC` (dominant, ~76%), `Cuero` (~24%)

**Notes:**
- `avaliable_units` is a known typo in the underlying view — **always use `available_units`**
- `safety_stock` is NULL for open box / clearance items
- `total_value` includes both material cost and transportation/freight allocation
- The view deduplicates with an AVG aggregate per (date, location, sku) — no duplicates expected
- For current inventory, always filter: `WHERE date = current_date('America/Los_Angeles')`
- To get warehouse-only totals (standard replenishment view), filter: `WHERE location_type IN ('warehouse', 'customization')`
- **`HAVING SUM(...) > 0` does not work on this view** — the view uses internal aggregation, so BigQuery rejects further `HAVING` aggregation. Wrap in a subquery and use `WHERE` instead:
  ```sql
  SELECT item_id, available_units FROM (
    SELECT item_id, SUM(available_units) AS available_units
    FROM inventory.inventory_daily WHERE ...
    GROUP BY item_id
  ) WHERE available_units > 0
  ```

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

### `replen.po_status`

**What it is:** A VIEW representing purchase order (PO) forecast status. One row per PO forecast × item. Shows what has been ordered, what has been received, what is on-the-water (OTW), and what remains outstanding. Contains ARRAY columns for container-level detail. Data goes back to 2022.

| column | type | notes |
|---|---|---|
| forecast_id | INT64 | PO forecast identifier |
| division_id | INT64 | Division identifier (NULL for old records) |
| division | STRING | Division name (e.g. `RTIC D2C`); NULL for old records |
| created | TIMESTAMP | When the PO forecast was created |
| closed | BOOL | Whether the PO forecast is closed/completed |
| memo | STRING | PO memo — may contain ship dates in MM/DD format |
| vendor | STRING | Vendor name |
| ship_date | DATE | Estimated ship/departure date (derived from memo dates, estimated_ship_start, or cargo_ready) |
| destination | STRING | Destination location name |
| title | STRING | Item title |
| parentName | STRING | Parent product name |
| pgc | STRING | Planning group category |
| pgn | STRING | Planning group name |
| item_id | INT64 | Item identifier — join key |
| version_id | INT64 | Version identifier |
| version | STRING | Version name (e.g. `Original`) |
| version_index | INT64 | Version index (0 = original) |
| rate | FLOAT64 | Unit cost rate |
| po_units | INT64 | Total units on the PO |
| received_units | INT64 | Units actually received |
| otw_units | INT64 | Units currently on-the-water (in transit) |
| remaining_units | INT64 | Units **not yet shipped** from vendor (still at factory; excludes OTW and received units) |
| excess_units | INT64 | `po_units - received_units` — positive = still outstanding, negative = over-received |
| first_otw_delivery_date | DATE | First OTW delivery date |
| last_otw_delivery_date | DATE | Last OTW delivery date |
| first_otw_intransit_date | DATE | First OTW in-transit date |
| last_otw_intransit_date | DATE | Last OTW in-transit date |
| otw_first_delivery_date | DATE | OTW first delivery date |
| otw_last_delivery_date | DATE | OTW last delivery date |
| containers | ARRAY<STRUCT<container_number STRING, quantity INT64, delivery_date DATE, seqnum STRING>> | Container-level summary |
| container_detail | ARRAY<STRUCT<container_number STRING, item_id INT64, quantity INT64, delivery_date DATE, seqnum STRING, in_transit_timestamp TIMESTAMP, origin_port STRING, destination_port STRING, via_dallas BOOL, route STRING>> | Detailed container info including port and route |
| is_late | BOOL | Whether the PO is late |

**Notes:**
- Filter `WHERE NOT closed` to get open/active POs only
- Filter `WHERE created > '2022-01-01'` — pre-2022 data is sparse/test data
- `remaining_units` = units **not yet shipped** from vendor (still at factory) — does NOT include OTW or received
- `po_units - received_units` = total units outstanding (not yet at warehouse) = `remaining_units + otw_units`
- `otw_units` = units currently on container ships in transit
- `excess_units` can be negative (received more than ordered) or positive (more units still expected)
- The ARRAY columns (`containers`, `container_detail`) require `UNNEST` to access row-level container data
- To access container routes: `UNNEST(container_detail) cd ON TRUE` then use `cd.route`, `cd.origin_port`, etc.
- `ship_date` is derived from multiple sources — treat as approximate
- Some old records have test vendor data (e.g. "Test Account Please Ignore") — filter by `created > '2022-06-01'` for clean data
- There is no standalone `status` or `po_type` column — use `closed` to distinguish open vs. closed POs

---

### `operations.receipts`

**What it is:** A table of actual inventory receipts. One row per item received per container per date. Records when physical inventory arrived at a warehouse location. Unlike `replen.po_status` which shows forecasted/expected receipts, this table shows what actually happened. Data includes RTIC brand receipts (Cuero receipts may be sparse).

| column | type | notes |
|---|---|---|
| date | DATE | Date the inventory was received |
| container_number | STRING | Container/shipment identifier (e.g. `TLLU5533586`) |
| po_id | INT64 | PO identifier; may be NULL |
| forecast_id | INT64 | PO forecast identifier — join to `replen.po_status.forecast_id` |
| vendor | STRING | Vendor name; may be NULL |
| item_id | INT64 | Item identifier — join key |
| category_path | STRING | Category hierarchy |
| parentName | STRING | Parent product name |
| variantName | STRING | Variant name |
| color | STRING | Color |
| size | STRING | Size |
| business | STRING | `RTIC` (primary) |
| reporting_division | STRING | Division for reporting (e.g. `Warehouse Operations`) |
| location_id | INT64 | Receiving location identifier |
| location | STRING | Receiving location name (e.g. `Katy HQ`) |
| units_received | INT64 | Number of units received |
| rate | FLOAT64 | Unit cost rate at time of receipt |
| freight | STRUCT<shipment_id STRING, container_base_cost FLOAT64, container_assessorial_cost FLOAT64, containers_received FLOAT64, containers_received_materials FLOAT64, freight_base_per_unit FLOAT64, freight_assessorial_per_unit FLOAT64, shipment_duty_rate FLOAT64, duty_per_unit FLOAT64> | Freight and duty cost details per unit |

**Notes:**
- `units_received` can be 0 for rows where the container arrived but specific items had 0 receipt (pre-receipt rows)
- Join to `replen.po_status` on `forecast_id` to link receipts back to the originating PO
- `freight.freight_base_per_unit` and `freight.duty_per_unit` may be NULL even when `units_received > 0`
- Only RTIC business is confirmed present; filter `WHERE business = 'RTIC'` if needed
- `location_name` does not exist — use `location` (the column is named `location`, not `location_name`)
- `container_number` links to `replen.po_status.container_detail.container_number` for full container tracking

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

### `retail.daily`

**What it is:** A VIEW with one row per date × retail location × item. Aggregates daily point-of-sale (POS) sales, returns, and on-hand inventory data from four retail partners — Walmart, Target, Lowe's, and West Marine — sourced from the Alloy retail data feed (`alloy-prod-customer-exports.rticoutdoors.*`). Also enriched with RTIC category hierarchy (from `analytics.items`) and an estimated unit cost derived from trailing wholesale sales in `analytics.item_metrics`. This is the primary table for retail channel analysis.

**Data coverage:**

| Retailer | Locations | Items | Earliest Date | Net Sales (all-time) |
|---|---|---|---|---|
| Walmart | 4,186 | 187 | 2023-12-09 | $102M |
| Target | 2,025 | 95 | 2023-11-10 | $21.8M |
| Lowe's | 1,626 | 100 | 2024-01-28 | $11.2M |
| West Marine | 244 | 67 | 2024-05-21 | $2.6M |

**Column reference:**

| column | type | notes |
|---|---|---|
| `date` | DATE | POS date |
| `retailer` | STRING | Partner name: `Walmart`, `Target`, `Lowe's`, `West Marine` |
| `location_number` | STRING | Retailer's store/DC identifier |
| `location_name` | STRING | Store name |
| `state` | STRING | State |
| `zip` | STRING | Postal code |
| `city` | STRING | City |
| `latitude` | FLOAT64 | Store latitude |
| `longitude` | FLOAT64 | Store longitude |
| `location_type` | STRING | `Store` or `Distribution Center` |
| `fulfillment_method` | STRING | `Store`, `DC to Home`, or NULL |
| `channel` | STRING | `In-store` or `e-Commerce` — derived from Alloy `POS Channel` if available, otherwise inferred from `location_type` |
| `item_id` | STRING | RTIC item ID — **stored as STRING**, must `SAFE_CAST(item_id AS INT64)` to join to `analytics.items` |
| `title` | STRING | RTIC item description |
| `target_name` | STRING | Target's product description (NULL for non-Target rows) |
| `target_dcpi` | STRING | Target DPCI number |
| `retailer_item_number` | STRING | Retailer's own item number (Walmart Prime Item Nbr, Target DPCI, Lowe's ID, or West Marine Item ID — whichever applies) |
| `retailer_item_name` | STRING | Retailer's product name |
| `sales_gross` | FLOAT64 | Gross POS sales (before returns), in USD |
| `sales_net` | FLOAT64 | Net POS sales (after returns), in USD — use this for revenue reporting |
| `units_gross` | FLOAT64 | Gross units sold (before returns) |
| `units_net` | FLOAT64 | Net units sold (after returns) — use this for unit reporting |
| `return_sales` | FLOAT64 | Return value in USD |
| `return_units` | FLOAT64 | Return unit count |
| `inventory_units` | FLOAT64 | On-hand units at this location on this date |
| `est_cost` | FLOAT64 | Estimated RTIC wholesale price per unit — rolling 6-month average of `analytics.item_metrics.sales / base_quantity` for wholesale orders to this retailer, grouped by month. Represents RTIC's revenue per unit sold TO the retailer (not consumer price). NULL when no historical wholesale sales exist for that item × retailer combination. |
| `category1` | STRING | Top-level category from `analytics.items.category_path` (e.g. `Drinkware`, `Hard Coolers`) |
| `category2` | STRING | Mid-level category |
| `category3` | STRING | Leaf-level category |
| `segment_id` | STRING | Alloy segment identifier |
| `product_id` | STRING | Alloy product identifier |

**Notes:**
- `item_id` is STRING — always `SAFE_CAST(item_id AS INT64)` before joining to `analytics.items` or any other table
- `Lowe's` uses a curly apostrophe in the data — filter as `WHERE retailer = 'Lowe''s'` in SQL
- Rows only exist when there is activity: `inventory_units <> 0 OR units_gross <> 0 OR return_sales <> 0` — zero-activity days are excluded
- `est_cost` is the wholesale price RTIC charges the retailer, not COGS. Use it to estimate RTIC revenue from retail sell-through: `units_net * est_cost`
- `channel = 'e-Commerce'` rows are Distribution Center rows (retailer fulfills online orders from DC inventory); `channel = 'In-store'` rows are physical store locations
- The view fixes an Alloy data quality issue where some product rows have NULL RTIC IDs — these are resolved by matching on `Walmart Prime Item Nbr` to recover the RTIC ID from sibling rows
- Source data is from `alloy-prod-customer-exports.rticoutdoors.*` — a separate GCP project managed by Alloy

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
WHERE date = '2026-03-23'  -- use latest available date
  AND inventory_units > 0
GROUP BY 1, 2, 3
ORDER BY 1, total_inventory_units DESC
```

---

### `marketing.ga4_sessions`

**What it is:** One row per GA4 web session. Built daily by a scheduled query from raw GA4 events (`marketing.ga4_data`), enriched with custom channel classification (`marketing.channel_mapping`), page-level product/order context, cart contents, and A/B test assignments. ~89.6M sessions total from April 2023 to present. Updated daily.

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
| `media_type` | STRING | Media type (e.g., `Paid Search`, `Paid Social`, `Email`) |
| `marketing_channel` | STRING | Standardized channel (e.g., `Paid Search`, `Meta`, `Email`, `Direct`, `Organic Search`, `Affiliates`) |
| `campaign_type` | STRING | Campaign type classification |
| `campaign_group` | STRING | Campaign group classification |
| `channel_mapping_rule` | INT64 | Which rule number in `channel_mapping` matched this session — useful for debugging misclassifications |
| `ad_content` | STRING | Ad content / creative identifier |
| `keyword` | STRING | Search keyword (for paid search sessions) |

**Session metrics:**

| column | type | notes |
|---|---|---|
| `new_visits` | INT64 | 1 if `first_visit` or `first_open` event fired (new user to the site) |
| `pageviews` | INT64 | Count of `page_view` events in the session |
| `is_bounce` | BOOL | TRUE if `pageviews ≤ 1` |
| `is_engaged` | BOOL | TRUE if any event had GA4's `session_engaged = 1` flag |
| `includes_checkout_page` | BOOL | TRUE if any page URL contained `/checkout` |
| `includes_cart_page` | BOOL | TRUE if any page URL contained `/cart` |
| `custom_shop_quote_submitted` | BOOL | TRUE if `customization_form_submission` event fired (Custom Shop B2B inquiry) |
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
| `operating_system` | STRING | OS name (e.g., `Android`, `iOS`, `Windows`) |
| `device_mobile_brand_name` | STRING | Phone manufacturer (e.g., `Samsung`, `Apple`) |
| `device_mobile_model_name` | STRING | Phone model |

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
| Direct | 9.7M | 1.77% | $38.7M |
| Meta | 8.6M | 0.68% | $5.4M |
| Paid Shopping | 3.2M | 2.78% | $13.7M |
| Email | 2.8M | 1.75% | $11.1M |
| SMS | 2.4M | 1.34% | $3.6M |
| Paid Search | 2.0M | 3.82% | $14.2M |
| Organic Search | 1.8M | 3.01% | $10.3M |
| Affiliates | 714K | 7.24% | $9.1M |
| TikTok | 481K | 0.30% | $135K |

**Device CVR (CY2025):** Desktop 2.80% >> Mobile 1.63% = Tablet 1.63%

**Notes:**
- `original_campaign` is the raw GA4 campaign name — always use this when filtering by specific campaign names (e.g., for A/B test analysis). `campaign` may be overridden by channel_mapping.
- `transaction_revenue` comes from GA4 ecommerce and can differ from `analytics.item_metrics` revenue due to GA4 deduplication, refunds, or client-side tracking gaps. For financial reporting, prefer `analytics.item_metrics`.
- `transaction_id` joins to `c2s_public.orders.unique_id` (not `order_id`) — it is the external/GA4 order ID, not the internal integer order ID
- `pages[].sales` is only populated for converting sessions and uses last-visit-wins logic per page type to avoid double-counting when a user visits the same product page multiple times
- `is_bounce = TRUE` means ≤ 1 pageview — does NOT mean the user left immediately; they may have been engaged (watched a video, scrolled) without triggering a second page_view
- The `channel_mapping_rule` value 93 = Direct (largest group, ~9.7M sessions); use this field to investigate unexpected channel classifications
- Table is large (~90M rows); always filter by `date` range for performance
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
| `replen.po_status` | `item_id` |
| `operations.receipts` | `item_id` |

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
