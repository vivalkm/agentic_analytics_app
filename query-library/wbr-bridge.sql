/*
description: This query pulls weekly T6W CP data in current and prior years, comparing actual performance metrics with forecasts.
T6W refers to "Trailing 6 Weeks" and CP stands for "contribution profit".
The query analyzes key metrics including transaction count, send volume, revenue, costs, and RLTE (Revenue Less Transaction Expenses).
------------
*/

with date_range as (select date_add('day', -(day_of_week(current_date) % 7) - 1, current_date)  as reporting_week_end
, date_add('day', -(day_of_week(current_date) % 7) - 72, current_date) as t6w_start)

, current_year as (
SELECT dd.week_start_date_inclusive
,dd.week_number
, reporting_group
, count(distinct transaction_id)                               as transactions
, sum(transaction_net_send_local * to_usd_market)              as send_vol
, sum(
(business_fx_revenue_local + transaction_net_fee_revenue_local) *
to_usd_market)                                              AS revenue
, sum(transaction_inflow_processing_fee_local * to_usd_market) AS send_cost
, sum(transaction_destination_fee_local * to_usd_market)       as dest_cost
, sum(
(transaction_nca_fraud_reserve_local + transaction_nth_fraud_reserve_local) *
to_usd_market)                                              as loss_cost
, sum((transaction_nth_tools_local + transaction_nca_tools_local) *
to_usd_market)                                           as other_cost
FROM fpa.transaction_economics t
JOIN public.date_dimension dd
ON dd.date_key = t.transaction_completed_date_key
WHERE 1 = 1
and dd.datevalue between (select t6w_start from date_range) and (select reporting_week_end from date_range)
and t.txn_is_core = True
and not customer_is_business
GROUP BY 1, 2,3
)


, prior_year as (
SELECT dd.week_start_date_inclusive
,dd.week_number
, reporting_group
, count(distinct transaction_id)                               as transactions
, sum(transaction_net_send_local * to_usd_market)              as send_vol
, sum(
(business_fx_revenue_local + transaction_net_fee_revenue_local) *
to_usd_market)                                              AS revenue
, sum(transaction_inflow_processing_fee_local * to_usd_market) AS send_cost
, sum(transaction_destination_fee_local * to_usd_market)       as dest_cost
, sum(
(transaction_nca_fraud_reserve_local + transaction_nth_fraud_reserve_local) *
to_usd_market)                                              as loss_cost
, sum((transaction_nth_tools_local + transaction_nca_tools_local) *
to_usd_market)                                           as other_cost
FROM fpa.transaction_economics t
JOIN public.date_dimension dd
ON dd.date_key = t.transaction_completed_date_key
WHERE 1 = 1
and dd.datevalue between (select t6w_start - interval '1' year - interval '7' day from date_range) and (select reporting_week_end  - interval '1' year + interval '7' day from date_range)
and t.txn_is_core = True
and not customer_is_business
GROUP BY 1, 2,3
)


, fcst as (
SELECT dd.week_start_date_inclusive
,dd.week_number
, reporting_group
, sum(transactions_forecast)                               as transactions
, sum(send_volume_forecast)              as send_vol
, sum(revenue_forecast)                                              AS revenue
, sum(send_cost_forecast) AS send_cost
, sum(dest_cost_forecast)       as dest_cost
, sum(loss_cost_forecast)                                              as loss_cost
, sum(other_cost_forecast)                                           as other_cost
FROM fpa.fpa_fcst_latest_daily_ma t
JOIN public.date_dimension dd
ON dd.datevalue = t.datevalue
WHERE 1 = 1
and dd.datevalue between (select t6w_start from date_range) and (select reporting_week_end from date_range)
GROUP BY 1, 2,3
)

select
week_start_date_inclusive
,cy.reporting_group
,transactions as txn
,send_vol
,revenue
,send_cost
,dest_cost
,loss_cost
,other_cost
,revenue - send_cost - dest_cost - loss_cost - other_cost as rlte
, case when cd.send_l1_group = 'AMER' then 'AMER'
when cd.send_l1_group in ('APAC', 'EMEA') then 'E&A'
ELSE 'Unmapped' End as "AMER/E&A"
,substr(cd.reporting_group, 1, 3) as send
,cd.send_l1_group as l1
,'actual' as scenario
from current_year cy
left join (select distinct reporting_group, send_l1_group from fpa.corridor_dimension) cd
on cy.reporting_group = cd.reporting_group

union all
select
week_start_date_inclusive
,py.reporting_group
,transactions
,send_vol
,revenue
,send_cost
,dest_cost
,loss_cost
,other_cost
,revenue - send_cost - dest_cost - loss_cost - other_cost as rlte
, case when cd.send_l1_group = 'AMER' then 'AMER'
when cd.send_l1_group in ('APAC', 'EMEA') then 'E&A'
ELSE 'Unmapped' End as "AMER/E&A"
,substr(cd.reporting_group, 1, 3) as send
,cd.send_l1_group as l1
,'actual' as scenario
from prior_year py
left join (select distinct reporting_group, send_l1_group from fpa.corridor_dimension) cd
on py.reporting_group = cd.reporting_group

union all
select
week_start_date_inclusive
,fcst.reporting_group
,transactions
,send_vol
,revenue
,send_cost
,dest_cost
,loss_cost
,other_cost
,revenue - send_cost - dest_cost - loss_cost - other_cost as rlte
, case when cd.send_l1_group = 'AMER' then 'AMER'
when cd.send_l1_group in ('APAC', 'EMEA') then 'E&A'
ELSE 'Unmapped' End as "AMER/E&A"
,substr(cd.reporting_group, 1, 3) as send
,cd.send_l1_group as l1
,'forecast' as scenario
from fcst
left join (select distinct reporting_group, send_l1_group from fpa.corridor_dimension) cd
on fcst.reporting_group = cd.reporting_group