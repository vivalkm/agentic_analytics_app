/*
description: this query is used to get financials for Remilty Business (also called SMB).
------------
*/

with																									
-- transaction period in scope, T6M until last month, with T3M loss data up until 3 months ago																									
date_range AS (SELECT DATE_TRUNC('month', current_date - interval '12' month) AS min_txn_month,																									
DATE_TRUNC('month', current_date - interval '0' month)  AS max_txn_month,																									
DATE_TRUNC('month', current_date - interval '3' month)  AS max_loss_month)																									
-- get business users based on payment profile																									
, business_user as (select distinct cd.customer_key																									
, cd.customer_public_id																									
, DATE_TRUNC('month', cd.customer_first_completed_transaction_datetime) as first_month																									
FROM public.customer_dimension cd																									
-- biz user definition: https://app.mode.com/remitly/reports/67128dd0605f/details/queries/0eaf4dea778d																									
where cd.customer_is_business)																									
																									
																									
, total_user_by_month as (																									
select DATE_TRUNC('month', first_month) as month																									
, count (customer_key) as new_users																									
, sum (count (customer_key))																									
over (order by DATE_TRUNC('month'																									
, first_month) rows between unbounded preceding and current row ) as total_users																									
from business_user																									
group by 1)																									
																									
																									
, actual_fraud_loss as (																									
SELECT txn.transaction_id, txn.customer_public_id,																									
-- net_send as actual_chargebacks_local,																									
txn.net_send_usd as actual_chargebacks_usd																									
from risk.risk_txn_mart txn																									
inner join business_user u																									
on u.customer_public_id = txn.customer_public_id																									
WHERE is_chargeback --flag for chargeback; chargeback == fraud at remitly																									
and txn.transaction_completed_datetime between (select min_txn_month from date_range)																									
AND (select max_loss_month from date_range))																									
-- transactions for business users																									
, cohort_txn_micro_biz_users as (																									
select t.transaction_customer_key																									
, t.transaction_completed_month																									
, case when transaction_is_first_completed_transaction then 1 else 0 end as nca
, count (t.transaction_id) as transaction_count
, sum (t.transaction_net_send_local * t.to_usd_market) AS send_volume																									
, sum (t.transaction_net_fee_revenue_local * t.to_usd_market) AS fee_revenue																									
, sum (t.business_fx_revenue_local * t.to_usd_market) AS business_fx_revenue																									
, sum (t.transaction_inflow_processing_fee_local * t.to_usd_market) AS pay_in_costs																									
, sum (t.transaction_destination_fee_local * t.to_usd_market) AS pay_out_costs																									
, sum ((t.transaction_nth_fraud_reserve_local +																									
t.transaction_nca_fraud_reserve_local) *																									
t.to_usd_market) AS allocated_loss_costs --avg reserve, allocated based on corridor, not customer nor txn																									
, sum (coalesce (f.actual_chargebacks_usd, 0)) as actual_loss_costs																									
, sum ((t.transaction_nth_tools_local + t.transaction_nca_tools_local) *																									
t.to_usd_market) AS tools_costs          --kyc and front checks of customers																									
FROM fpa.transaction_economics t																									
left join actual_fraud_loss f																									
on f.transaction_id = t.transaction_id																									
where t.transaction_completed_month BETWEEN (select min_txn_month from date_range)																									
AND (select max_txn_month from date_range)																									
and txn_is_core																									
and customer_is_business																									
group by 1, 2, 3)					


     ,customers AS (
          SELECT
               cd.reporting_group_2025     AS reporting_group
             , transaction_customer_key    AS customer_key
             , transaction_completed_month AS cohort_month
          FROM
               fpa.transaction_economics t
               inner join fpa.corridor_dimension cd ON t.transaction_corridor_key = cd.corridor_key
          WHERE
               transaction_is_first_completed_transaction
               AND transaction_completed_month <= (select max_txn_month from date_range)
               AND t.txn_is_core = TRUE
               and t.customer_is_business
     )
   , active_cx as (
            select t.reporting_group
                    ,t.transaction_customer_key
                    , c.cohort_month
                    , array_agg(DISTINCT t.transaction_completed_month) as completed_month_array
            from fpa.transaction_economics t
            inner join fpa.corridor_dimension cd
             on t.transaction_corridor_key = cd.corridor_key
            inner join customers c
                     on c.customer_key = t.transaction_customer_key
            where t.transaction_completed_month <= (select max_txn_month from date_range)
              and t.txn_is_core
              and t.customer_is_business
            group by 1,2,3)
, qau as (
select dr.month as calendar_month, count (distinct ac.transaction_customer_key) as t3M_au
from (select distinct date_trunc('month', datevalue) as month
    from public.date_dimension
    where datevalue <= (select max_txn_month from date_range)) dr
    join active_cx ac
on any_match(ac.completed_month_array, x -> x between date_add('month', -2, dr.month) and dr.month)
group by 1
)
																									
, pnl as (
select date(transaction_completed_month)   as calendar_month																									 
, tu.total_users                           as total_users																									
, count(distinct transaction_customer_key) as active_users			
, sum(nca) as ncas
, sum(transaction_count)                   as transaction_count																									
, sum(send_volume)                         as send_volume																									
, sum(fee_revenue)                         as fee_revenue																									
, sum(business_fx_revenue)                 as business_fx_revenue																									
, sum(pay_in_costs)                        as pay_in_costs																									
, sum(pay_out_costs)                       as pay_out_costs																									
, sum(allocated_loss_costs)                as allocated_loss_costs																									
, sum(actual_loss_costs)                   as actual_loss_costs																									
, sum(tools_costs)                         as tools_costs																									
from cohort_txn_micro_biz_users txn																									
left join total_user_by_month tu																									
on txn.transaction_completed_month = date(tu.month)																									
group by 1, 2																									
order by 1
)

SELECT
pnl.*
,qau.t3M_au
from pnl
left join qau
on pnl.calendar_month = qau.calendar_month