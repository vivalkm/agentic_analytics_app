# Domain Context

This file provides business context for the SQL reviewer and generator.
Terms defined here override any assumptions the LLM might make.

## Terminology

- **business revenue** / **revenue**: General company revenue metric. This does NOT refer to SMB or the "Remitly Business" product. Do NOT filter on `customer_is_business` unless the user explicitly asks about SMB, business customers, or the Remitly Business product.
- **SMB** / **business customers** / **Remitly Business**: Refers to the B2B product for small/medium businesses. Use `customer_is_business = TRUE` only when these terms are used.
- **consumer**: Non-business customers (`customer_is_business = FALSE`). Only filter for consumer when the user explicitly asks about consumer-specific metrics.

## Common Pitfalls

- Do NOT assume "business revenue" means revenue from business customers. It means total company revenue.
- Do NOT add `customer_is_business` filters unless the user explicitly mentions SMB or business customers.
