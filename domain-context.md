# Domain Context

This file provides business context for the SQL reviewer and generator.
Terms defined here override any assumptions the LLM might make.

## Terminology

- **business revenue** / **revenue**: General company revenue metric. This does NOT refer to SMB or the "Remitly Business" product.
- **SMB** / **business customers** / **Remitly Business**: Refers to the B2B product for small/medium businesses. Use `customer_is_business = TRUE` only when these terms are used.
- **consumer**: Non-business customers (`customer_is_business = FALSE`).
- **core remittance**: The traditional consumer-to-consumer remittance business, excluding SMB (Remitly Business) and Rewire. Filter out SMB and Rewire transactions (e.g. `reporting_group NOT IN ('SMB', 'Rewire')` or equivalent column filters depending on the table).
- **reporting_group**: A region-to-region pair (e.g. "USA-MEX", "CAN-IND", "MEA-CAN"). Each reporting_group contains one or more corridors. When a user asks about a "region" or "reporting group", use `reporting_group`.
- **corridor**: A country-to-country pair within a reporting_group. More granular than reporting_group. When a user asks about a specific "corridor" or "country pair", use the corridor column (e.g. `send_country`, `receive_country`, or a corridor-specific column depending on the table).

## Default Core Remittance Filters

By default, we are interested in the **core remittance business**. When a table has these columns, always apply these filters unless the user explicitly asks otherwise:

- `customer_is_business = FALSE` — excludes SMB (Remitly Business). Use TRUE only if user asks about SMB. Omit only if user asks about "all customers" or "total".
- `txn_is_core = TRUE` — includes only core remittance transactions (excludes Rewire and other non-core). Omit only if user asks about all transaction types, Rewire, or non-core.

## Forecast Data

- **Monthly forecast**: Always use `fpa.fpa_fcst_latest` for monthly-level forecast data.
- **Daily forecast**: Always use `fpa.fpa_fcst_latest_daily_ma` for daily-level forecast allocations (monthly forecast allocated to daily using moving-average weights).
- Do NOT use other forecast tables unless the user explicitly names one.

## Payment Method / Pay-In Type

**MANDATORY**: When the user asks about payment method, pay-in method, pay-in type, or how customers pay, you MUST follow these rules exactly:

- The ONLY table for payment method lookup is `lakehouse.public.payment_profile_dimension`.
- The ONLY column for pay-in type is `payment_instrument_type`.
- To get pay-in type at the transaction level, JOIN like this:
  ```sql
  JOIN lakehouse.public.payment_profile_dimension ppd
    ON ppd.payment_profile_key = te.transaction_payment_profile_key
  ```
- Do NOT look for payment/pay-in columns directly on `transaction_economics` — they do not exist there.
- Do NOT use forecast tables for actuals pay-in breakdown.

## Common Pitfalls

- Do NOT assume "business revenue" means revenue from business customers. It means total company revenue.
- When "core remittance" is mentioned, always exclude SMB and Rewire from the results.
- Always apply the default SMB exclusion (`customer_is_business = FALSE`) when the column is available, unless the user says otherwise.
