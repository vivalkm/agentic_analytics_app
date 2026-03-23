with date_range_staging as (select current_date - interval '1' day as reporting_date)
   , date_range as (select reporting_date
                         , date_trunc('month', reporting_date) -
                           interval '1' month                                        as pm_start
                         , date_trunc('month', reporting_date)                       as cm_start
                         , last_day_of_month(reporting_date)                         as cm_end
                         , date_trunc('month', reporting_date) - interval '1' month -
                           interval '1' year                                         as py_pm_start
                         , date_trunc('month', reporting_date) - interval '1' year   as py_cm_start
                         , last_day_of_month(date_trunc('month', reporting_date) -
                                             interval '1' year + interval '1' month) as py_nm_end
                         -- Before 1/21 there is no T21 var for forecast due to changes in reporting group in forecast_year_1 vs forecast_year_0, hence use YoY method (mtd_day_mix = 0) during the period
                         , case
                               when extract(month from reporting_date) = 1 and
                                    extract(day from reporting_date) < 21 then 0
                               else
                                   cast(extract(day from reporting_date) as double) /
                                   extract(day
                                           from date_trunc('month', reporting_date) + interval '1' month -
                                                interval '1' day) end                as mtd_day_mix
                    from date_range_staging)

    /* Calculate weekday alignment YoY */
   , weekday_diff AS (SELECT day_of_week(cm_start) - day_of_week(py_cm_start) AS diff
                      FROM date_range)

   , weekday_alignment_staging AS (SELECT CASE
                                              WHEN diff < 0 THEN diff + 7
                                              ELSE diff
                                              END AS diff1,

                                          CASE
                                              WHEN diff >= 0 THEN diff - 7
                                              ELSE diff
                                              END AS diff2
                                   FROM weekday_diff)

   , weekday_alignment AS (SELECT CASE
                                      WHEN abs(diff1) <= abs(diff2) THEN diff1
                                      ELSE diff2
                                      END AS weekday_alignment_days
                           FROM weekday_alignment_staging)
    /* End of weekday alignment calculation */


   -- Actuals of current month, prior year, prior year, T21D send volume, T-7 | T-14 | T-21 take rate, MTD send vol, MTD revenue by reporting group
   , actual_by_reporting_group as (SELECT scenario
                                        , datevalue
                                        , calendar_year
                                        , calendar_month_number_in_year
                                        , day_number_in_calendar_month
                                        , reporting_group
                                        , send_vol
                                        , send_vol_in_constant_currency
                                        , revenue
                                        , revenue_in_constant_currency
                                        , ncas
                                        , treasury_margin
                                        , transactions
                                   FROM fpa.daily_outlook
                                   WHERE scenario = 'Actual')

    /* Daily forecast for current month */
   , forecast_by_reporting_group as (SELECT scenario
                                          , datevalue
                                          , calendar_year
                                          , calendar_month_number_in_year
                                          , day_number_in_calendar_month
                                          , reporting_group
                                          , send_vol
                                          , revenue
                                          , ncas
                                          , treasury_margin
                                          , transactions
                                     FROM fpa.daily_outlook
                                     WHERE scenario = 'Forecast')
    /* Outlook for rest of current month */
   , outlook_consol as (select reporting_group
                             , sum(send_vol)             as send_vol_outlook
                             , sum(take_rate * send_vol) as revenue_outlook
                             , sum(ncas)                 as ncas_outlook
                             , sum(transactions)         as transactions_outlook
                        from fpa.daily_outlook
                        WHERE scenario = 'Outlook'
                        group by 1)
    /* treasury margin by reporting group, flagging for abnormal cost_basis rates vs. trade rates */
   , treasury_margin as (select cd.reporting_group                                    as reporting_group
                              , sum(coalesce(tm.holding_gain_to_usd, 0) + coalesce(tm.holding_gain_from_usd, 0))     as tm_holding_gain
                              , sum(coalesce(tm.net_trade_cost_to_usd, 0) + coalesce(tm.net_trade_cost_from_usd, 0)) as tm_net_trade_cost
                              , bool_or(tm.abnormal_rate_flag) as abnormal_rate_flag
                         from fpa.transaction_economics t
                                  left join public.date_dimension dd
                                            on t.transaction_completed_date_key = dd.date_key
                                  left join fpa.treasury_margin_split tm
                                            on t.transaction_id = tm.transaction_id
                                  left join fpa.corridor_dimension cd
                                            on t.transaction_corridor_key = cd.corridor_key
                         where dd.datevalue between (select cm_start from date_range) and (select reporting_date from date_range)
                                -- remove SMB, Circle and Rewire
                                AND txn_is_core = True
                                AND customer_is_business = false
                         group by 1)

    /* Reporting layer
        One row for each reporting_group
        Columns contains:
          - send_vol: mtd_act, mtd_py, mtd_fcst, mtd_act + outlook, cm_py, cm_fcst
          - revenue: mtd_act, mtd_py, mtd_fcst, mtd_act + outlook, cm_py, cm_fcst
          - take_rate: calculation
          - ncas: mtd_act, mtd_py, mtd_fcst, mtd_act + outlook, cm_py, cm_fcst
    */
   , index_rg as (
       select distinct
           reporting_group
           ,datevalue
           , calendar_year
            , calendar_month_number_in_year
            , day_number_in_calendar_month
       from forecast_by_reporting_group
       union
       select distinct
           reporting_group
           ,datevalue
           , calendar_year
            , calendar_month_number_in_year
            , day_number_in_calendar_month
       from actual_by_reporting_group
)
   , report_reporting_group_staging as (select i.reporting_group
                                             , sum(case
                                                       when a_cy.calendar_year =
                                                            (select extract(year from reporting_date) from date_range) and
                                                            a_cy.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_cy.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_cy.send_vol
                                                       else 0 end) as mtd_send_vol_cy
                                              , sum(case
                                                       when a_cy.calendar_year =
                                                            (select extract(year from reporting_date) from date_range) and
                                                            a_cy.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_cy.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_cy.send_vol_in_constant_currency
                                                       else 0 end) as mtd_send_vol_cy_in_constant_currency
                                             , sum(case
                                                       when a_cy.calendar_year =
                                                            (select extract(year from reporting_date) from date_range) and
                                                            a_cy.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_cy.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_cy.revenue
                                                       else 0 end) as mtd_revenue_cy
                                            , sum(case
                                                       when a_cy.calendar_year =
                                                            (select extract(year from reporting_date) from date_range) and
                                                            a_cy.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_cy.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_cy.revenue_in_constant_currency
                                                       else 0 end) as mtd_revenue_cy_in_constant_currency
                                             , sum(case
                                                       when a_cy.calendar_year =
                                                            (select extract(year from reporting_date) from date_range) and
                                                            a_cy.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_cy.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_cy.treasury_margin
                                                       else 0 end) as mtd_treasury_margin_cy
                                             , sum(case
                                                       when a_cy.calendar_year =
                                                            (select extract(year from reporting_date) from date_range) and
                                                            a_cy.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_cy.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_cy.ncas
                                                       else 0 end) as mtd_ncas_cy
                                             , sum(case
                                                       when a_cy.calendar_year =
                                                            (select extract(year from reporting_date) from date_range) and
                                                            a_cy.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_cy.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_cy.transactions
                                                       else 0 end) as mtd_transactions_cy
                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.send_vol
                                                       else 0 end) as mtd_send_vol_py
                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.revenue
                                                       else 0 end) as mtd_revenue_py
                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.treasury_margin
                                                       else 0 end) as mtd_treasury_margin_py
                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.ncas
                                                       else 0 end) as mtd_ncas_py
                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.transactions
                                                       else 0 end) as mtd_transactions_py
                                             , sum(case
                                                       when f.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range)
                                                           then f.send_vol
                                                       else 0 end) as mtd_send_vol_fcst
                                             , sum(case
                                                       when f.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range)
                                                           then f.revenue
                                                       else 0 end) as mtd_revenue_fcst
                                             , sum(case
                                                       when f.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range)
                                                           then f.ncas
                                                       else 0 end) as mtd_ncas_fcst
                                             , sum(case
                                                       when f.day_number_in_calendar_month <=
                                                            (select extract(day from reporting_date) from date_range)
                                                           then f.transactions
                                                       else 0 end) as mtd_transactions_fcst

                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.send_vol
                                                       else 0 end) as cm_send_vol_py
                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.revenue
                                                       else 0 end) as cm_revenue_py
                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.ncas
                                                       else 0 end) as cm_ncas_py
                                             , sum(case
                                                       when a_py.calendar_year =
                                                            (select extract(year from reporting_date) - 1 from date_range) and
                                                            a_py.calendar_month_number_in_year =
                                                            (select extract(month from reporting_date) from date_range)
                                                           then a_py.transactions
                                                       else 0 end) as cm_transactions_py
                                             , sum(f.send_vol)     as cm_send_vol_fcst
                                             , sum(f.revenue)      as cm_revenue_fcst
                                             , sum(f.ncas)         as cm_ncas_fcst
                                             , sum(f.transactions)         as cm_transactions_fcst

                                        from
                                            index_rg i
                                            left join forecast_by_reporting_group f
                                                    on f.reporting_group = i.reporting_group
                                                    and f.datevalue = i.datevalue
                                                 left join actual_by_reporting_group a_cy
                                                           on a_cy.reporting_group = i.reporting_group
                                                               and a_cy.datevalue = i.datevalue
                                                 left join actual_by_reporting_group a_py
                                                           on a_py.reporting_group = i.reporting_group
                                                               and a_py.calendar_year = i.calendar_year - 1
                                                               and a_py.calendar_month_number_in_year =
                                                                   i.calendar_month_number_in_year
                                                               and
                                                              a_py.day_number_in_calendar_month =
                                                              i.day_number_in_calendar_month

                                        where i.datevalue between (select cm_start from date_range) and (select cm_end from date_range)
                                        group by 1)

    /* calculate take rate by reporting group, concat with outlook and treasury margin bridge */
   , report_reporting_group as (select rrgs.*
                                     , mtd_send_vol_cy + coalesce(o.send_vol_outlook, 0)            as cm_send_vol_outlook
                                     , mtd_revenue_cy + coalesce(o.revenue_outlook, 0)              as cm_revenue_outlook
                                     , mtd_ncas_cy + coalesce(o.ncas_outlook, 0)                    as cm_ncas_outlook
                                     , mtd_transactions_cy + coalesce(o.transactions_outlook, 0)    as cm_transactions_outlook
                                     , coalesce(mtd_revenue_cy / NULLIF(mtd_send_vol_cy, 0), 0)     as mtd_take_rate_cy
                                     , coalesce(mtd_revenue_py / NULLIF(mtd_send_vol_py, 0), 0)     as mtd_take_rate_py
                                     , coalesce(mtd_revenue_fcst / NULLIF(mtd_send_vol_fcst, 0), 0) as mtd_take_rate_fcst
                                     , coalesce(
            (mtd_revenue_cy + coalesce(o.revenue_outlook, 0)) /
            NULLIF(mtd_send_vol_cy + coalesce(o.send_vol_outlook, 0), 0),
            0)                                                                                      as cm_take_rate_outlook
                                     , coalesce(cm_revenue_py / NULLIF(cm_send_vol_py, 0), 0)       as cm_take_rate_py
                                     , coalesce(cm_revenue_fcst / NULLIF(cm_send_vol_fcst, 0), 0)   as cm_take_rate_fcst
                                     , tm.tm_holding_gain
                                     , tm.tm_net_trade_cost
                                     , tm.abnormal_rate_flag
                                from report_reporting_group_staging rrgs
                                         left join outlook_consol o
                                                   on o.reporting_group = rrgs.reporting_group
                                         left join treasury_margin tm
                                                   on rrgs.reporting_group = tm.reporting_group)


   , reporting_group_mapping as (select distinct 'Global'                as layer0
                                               , case
                                                     when c.send_l1_group = 'AMER' THEN 'AMER'
                                                     WHEN c.send_l1_group IN ('EMEA', 'APAC')
                                                         THEN 'E&A'
                                                     ELSE 'Unmapped' end as layer1
                                               , case
                                                     when c.send_l1_group in ('AMER') THEN c.send_l3_group
                                                     WHEN c.send_l1_group IN ('EMEA', 'APAC')
                                                         THEN c.send_l1_group
                                                     ELSE 'Unmapped' end as layer2
                                               , c.send_l3_group         as layer3
                                               , r.reporting_group
                                 from report_reporting_group r
                                          -- TODO: When reporting group changes, change this line to the new reporting group
                                          left join (select distinct reporting_group
                                                                   , origination_business_region_code
                                                                   , send_l1_group
                                                                   , send_l2_group
                                                                   , send_l3_group
                                                                   , receive_l1_group
                                                                   , receive_l2_group
                                                     from fpa.corridor_dimension
                                                     where origination_business_region_code is not null) c
                                                    on r.reporting_group = c.reporting_group)
select m.layer0
     , m.layer1
     , m.layer2
     , m.layer3
     , r.reporting_group
     , r.mtd_send_vol_cy
     , r.mtd_send_vol_cy_in_constant_currency
     , r.mtd_revenue_cy
     , r.mtd_revenue_cy_in_constant_currency
     , r.mtd_treasury_margin_cy
     , r.mtd_send_vol_py
     , r.mtd_revenue_py
     , r.mtd_treasury_margin_py
     , r.mtd_send_vol_fcst
     , r.mtd_revenue_fcst
     , r.cm_send_vol_outlook
     , r.cm_revenue_outlook
     , r.cm_send_vol_py
     , r.cm_revenue_py
     , r.cm_send_vol_fcst
     , r.cm_revenue_fcst
     , r.mtd_take_rate_cy
     , r.mtd_take_rate_py
     , r.mtd_take_rate_fcst
     , r.cm_take_rate_outlook
     , r.cm_take_rate_py
     , r.cm_take_rate_fcst
     , (mtd_send_vol_cy_in_constant_currency - mtd_send_vol_fcst) * mtd_take_rate_cy        as mtd_act_vs_fcst_ctc_send_vol_in_constant_currency
     , (mtd_send_vol_cy - mtd_send_vol_fcst) * mtd_take_rate_cy        as mtd_act_vs_fcst_ctc_send_vol
     , (mtd_take_rate_cy - mtd_take_rate_fcst) * mtd_send_vol_fcst     as mtd_act_vs_fcst_ctc_take_rate
     , (cm_send_vol_outlook - cm_send_vol_fcst) * cm_take_rate_outlook as cm_outlook_vs_fcst_ctc_send_vol
     , (cm_take_rate_outlook - cm_take_rate_fcst) * cm_send_vol_fcst   as cm_outlook_vs_fcst_ctc_take_rate
     , r.mtd_ncas_cy
     , r.mtd_ncas_py
     , r.mtd_ncas_fcst
     , r.cm_ncas_outlook
     , r.cm_ncas_py
     , r.cm_ncas_fcst
     , r.tm_holding_gain
     , r.tm_net_trade_cost
     , r.mtd_transactions_cy
     , r.mtd_transactions_py
     , r.mtd_transactions_fcst
     , r.cm_transactions_outlook
     , r.cm_transactions_py
     , r.cm_transactions_fcst
     , r.abnormal_rate_flag
from report_reporting_group r
         left join reporting_group_mapping m
                   on r.reporting_group = m.reporting_group
