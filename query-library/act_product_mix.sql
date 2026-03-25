/*
description: this query extracts transaction data by pay in method, product, and delivery partner, filtering for material transaction volumes and calculating transaction mix metrics across reporting groups and customer types
------------
*/

WITH
  partner_dim AS (
    SELECT DISTINCT
      destination_id
    , partner_id
    , partner_delivery
    , transaction_receiver_currency_key
    , receive_country
    , partner_name
    , destination_name
    FROM
      fpa_raw.forecast_dest_cogs
  )
, txn_by_product_partner AS (
    SELECT
      cd.reporting_group
    , t.customer_is_business
    , t.transaction_product_key
    , t.transaction_sender_currency_key
    , t.transaction_receiver_currency_key
    , cd.send_region_name
    , cd.receive_region_name
    , COALESCE(pd_1.partner_id, pd_2.partner_id, 0)                   AS partner_id
    , COALESCE(pd_1.destination_id, pd_2.destination_id, 0)           AS destination_id
    , COALESCE(pd_1.partner_name, pd_2.partner_name, 'Other')         AS partner_name
    , COALESCE(pd_1.destination_name, pd_2.destination_name, 'Other') AS destination_name
    , COALESCE(pd_1.partner_delivery, pd_2.partner_delivery, 'Other') AS partner_delivery
    , CASE
        WHEN payment_instrument_type = 'sofort' THEN 'klarna'
        WHEN (
          payment_profile_is_prepaid
          AND (
            ---this is to capture prepaid in EUR
            (t.transaction_sender_currency_key = 'EUR')
            OR
            ----this is to convert MC Unreg Debit to Prepaid
            (
              t.transaction_sender_currency_key = 'USD'
              AND payment_profile_card_brand = 'MasterCard'
              AND NOT payment_profile_is_regulated
            )
          )
        ) THEN 'prepaid'
        WHEN ppd.payment_instrument_type IN ('checking', 'savings', 'direct_deposit', 'open_banking') THEN 'bank'
        WHEN ppd.payment_instrument_type in ('apple_pay_credit','google_pay_credit') then 'credit'
        WHEN REGEXP_LIKE(ppd.payment_instrument_type, 'apple_pay|google_pay') THEN 'debit'
        WHEN ppd.payment_instrument_type IN ('loan', 'wallet') THEN 'debit'
        WHEN ppd.payment_instrument_type IN ('interac', 'sepa', 'ideal') THEN ppd.payment_instrument_type
        WHEN ppd.payment_instrument_type IN ('bancontact', 'payto') THEN 'other'
        ELSE COALESCE(payment_instrument_type, 'other')
      END AS pay_in_method
    , CASE
        WHEN ppd.payment_instrument_type IN ('checking', 'savings', 'direct_deposit', 'open_banking') THEN 'none'
        WHEN ppd.payment_profile_card_brand IN ('Unknown', '(not set)') THEN 'Visa'
        WHEN ppd.payment_profile_card_brand IS NULL THEN 'none'
        ELSE ppd.payment_profile_card_brand
      END AS payment_profile_card_brand
    , CASE
        WHEN (
          t.transaction_sender_currency_key = 'USD'
          AND ppd.payment_instrument_type = 'debit'
          AND ppd.payment_profile_is_regulated
        ) THEN 'Yes'
        ELSE 'No'
      END AS payment_profile_is_regulated
    , COUNT(*) AS txn
    , SUM(COALESCE(transaction_net_send_local, 0)) AS net_send_local
    , SUM(COALESCE(t.business_fx_revenue_local, 0)) AS business_fx_revenue_local
    , SUM(COALESCE(t.transaction_net_fee_revenue_local, 0)) AS transaction_net_fee_revenue_local
    FROM
      fpa.transaction_economics t
      LEFT JOIN fpa.corridor_dimension cd ON t.transaction_corridor_key = cd.corridor_key
      LEFT JOIN partner_dim pd_1 ON t.transaction_receiver_currency_key = pd_1.transaction_receiver_currency_key
      AND cd.receive_region_name = pd_1.receive_country
      AND pd_1.partner_id = t.transaction_partner_key
      AND t.transaction_receiver_destination_key = pd_1.destination_id
      LEFT JOIN partner_dim pd_2 ON t.transaction_receiver_currency_key = pd_2.transaction_receiver_currency_key
      AND cd.receive_region_name = pd_2.receive_country
      AND pd_2.partner_id = t.transaction_partner_key
      AND pd_2.destination_id = 0
      INNER JOIN public.payment_profile_dimension ppd ON t.transaction_payment_profile_key = ppd.payment_profile_key
    WHERE
      t.transaction_completed_month BETWEEN DATE('{first_act_month}') AND DATE('{last_act_month}')
      AND t.txn_is_core
    GROUP BY
      1
    , 2
    , 3
    , 4
    , 5
    , 6
    , 7
    , 8
    , 9
    , 10
    , 11
    , 12
    , 13
    , 14
    , 15
  )
, product_partner_in_scope_staging AS (
    SELECT
      reporting_group
    , customer_is_business
    , transaction_product_key
    , transaction_sender_currency_key
    , transaction_receiver_currency_key
    , send_region_name
    , receive_region_name
    , partner_id
    , destination_id
    , partner_name
    , destination_name
    , partner_delivery
    , pay_in_method
    , payment_profile_card_brand
    , payment_profile_is_regulated
    , txn
    , net_send_local
    , business_fx_revenue_local
    , transaction_net_fee_revenue_local
    , CAST(txn AS DOUBLE) / SUM(txn) OVER (
        PARTITION BY
          reporting_group
          ,customer_is_business
      ) AS txn_mix
    , CAST(net_send_local AS DOUBLE) / SUM(net_send_local) OVER (
        PARTITION BY
          reporting_group
          ,customer_is_business
      ) AS send_mix
    , txn = MAX(txn) OVER (
        PARTITION BY
          reporting_group
          ,customer_is_business
          , pay_in_method
          , partner_delivery
      ) is_top_product
    FROM
      txn_by_product_partner
  )
SELECT
  reporting_group
, customer_is_business
, transaction_product_key
, transaction_sender_currency_key
, transaction_receiver_currency_key
, send_region_name
, receive_region_name
, partner_id
, partner_name
, destination_id
, destination_name
, partner_delivery
, pay_in_method
, payment_profile_card_brand
, payment_profile_is_regulated
-- mix totaling to 1 within each pair of reporting group and customer type (biz vs non-biz)
, CAST(txn AS DOUBLE) / SUM(txn) OVER (
    PARTITION BY
      reporting_group
      , customer_is_business
  ) AS txn_mix
, CAST(net_send_local AS DOUBLE) / SUM(net_send_local) OVER (
    PARTITION BY
      reporting_group
      , customer_is_business
  ) AS send_mix
, DATE('{first_act_month}') AS first_month_in_scope
, DATE('{last_act_month}') AS last_month_in_scope
FROM
  product_partner_in_scope_staging s
  LEFT JOIN fpa_intermediate.fpa_forecast_staging_constant_currency cc ON s.transaction_sender_currency_key = cc.currency_key
WHERE
  -- filter out immaterial product mix unless it's the top product in the reporting group
  txn > 1000
  OR txn_mix > 0.01
  OR send_mix > 0.01
  OR is_top_product
  or (payment_profile_card_brand = 'Discover'
      and  (txn > 200
            or txn_mix > 0.001
            OR send_mix > 0.001))