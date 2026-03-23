-- the query pulls core remittance (excluding Remitly Business (also called SMB) and Rewire (sent from Israel)) transaction data for a specific date range, and calculates various metrics related to remittance revenue and profit.
-- key filters by product
-- For SMB data: txn_is_core and customer_is_business = True
-- For Rewire data: txn_is_migrated_rewire and transaction_remittance_distro_id = 'app_id_ra_ril'

select 
  dd.datevalue
  , cd.send_l1_group
  , cd.send_region_name
  , te.transaction_id
  , te.transaction_net_send_local * COALESCE(to_usd_market, 1) as send_volume_usd
  , (te.business_fx_revenue_local + te.transaction_net_fee_revenue_local) * COALESCE(to_usd_market, 1) as business_revenue_usd
  , COALESCE(tm.treasury_fx_margin_to_usd, 0) + COALESCE(tm.treasury_fx_margin_from_usd, 0) as treasury_margin_usd
  , (te.business_fx_revenue_local + te.transaction_net_fee_revenue_local) * COALESCE(to_usd_market, 1) + COALESCE(tm.treasury_fx_margin_to_usd, 0) + COALESCE(tm.treasury_fx_margin_from_usd, 0) as remittance_revenue_usd
  , te.transaction_total_profit_local * COALESCE(to_usd_market, 1) as rlte_usd
from fpa.transaction_economics te
    left join fpa.corridor_dimension cd
      on te.transaction_corridor_key = cd.corridor_key
    left join fpa.treasury_margin_split tm
      on te.transaction_id = tm.transaction_id
    left join public.date_dimension dd
      on dd.date_key = te.transaction_completed_date_key
where 
  datevalue date '2025-09-01' AND date '2025-09-30'
  and te.customer_is_business = false
  and txn_is_core