# Domain Context

This file provides business context for the SQL reviewer and generator.
Terms defined here override any assumptions the LLM might make.

## Terminology

- **business revenue** / **revenue**: General company revenue metric. This does NOT refer to SMB or the "Remitly Business" product.
- **SMB** / **business customers** / **Remitly Business**: Refers to the B2B product for small/medium businesses. Use `customer_is_business = TRUE` only when these terms are used.
- **consumer**: Non-business customers (`customer_is_business = FALSE`).
- **core remittance**: The traditional consumer-to-consumer remittance business, excluding SMB (Remitly Business) and Rewire. Filter out SMB and Rewire transactions (e.g. `reporting_group NOT IN ('SMB', 'Rewire')` or equivalent column filters depending on the table).

## Default Core Remittance Filters

By default, we are interested in the **core remittance business**. When a table has these columns, always apply these filters unless the user explicitly asks otherwise:

- `customer_is_business = FALSE` — excludes SMB (Remitly Business). Use TRUE only if user asks about SMB. Omit only if user asks about "all customers" or "total".
- `txn_is_core = TRUE` — includes only core remittance transactions (excludes Rewire and other non-core). Omit only if user asks about all transaction types, Rewire, or non-core.

## Forecast Data

- **Monthly forecast**: Always use `fpa.fpa_fcst_latest` for monthly-level forecast data.
- **Daily forecast**: Always use `fpa.fpa_fcst_latest_daily_ma` for daily-level forecast allocations (monthly forecast allocated to daily using moving-average weights).
- Do NOT use other forecast tables unless the user explicitly names one.

## Common Pitfalls

- Do NOT assume "business revenue" means revenue from business customers. It means total company revenue.
- When "core remittance" is mentioned, always exclude SMB and Rewire from the results.
- Always apply the default SMB exclusion (`customer_is_business = FALSE`) when the column is available, unless the user says otherwise.
