/*
description: This query extracts daily financial metrics (send volume, revenue, take rate, etc.) 
by reporting group and region from the daily outlook data. It includes date calculations 
for current month, prior month, and year-over-year comparisons with weekday alignment adjustments.
------------
*/


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


   -- Actuals of current month, prior month, prior year by reporting group
   -- Daily forecast of current month and prior month
   -- Daily outlook of current month
   , daily_by_reporting_group as (SELECT scenario
                                        , datevalue
                                        , calendar_year
                                        , calendar_month_number_in_year
                                        , day_number_in_calendar_month
                                        , reporting_group
                                        , send_vol
                                        , revenue
                                        , take_rate
                                        , ncas
                                        , transactions
                                        , treasury_margin
                                   FROM fpa.daily_outlook)


   , reporting_staging as (select scenario
                                , datevalue
                                , calendar_year
                                , calendar_month_number_in_year
                                , day_number_in_calendar_month
                                , reporting_group
                                , send_vol
                                , revenue
                                , take_rate
                                , ncas
                                , transactions
                                , treasury_margin
                           from daily_by_reporting_group

)

select rs.scenario
             , rs.datevalue
             , rs.calendar_year
             , rs.calendar_month_number_in_year
             , rs.day_number_in_calendar_month
             , rs.reporting_group
             , rs.send_vol
             , rs.revenue
             , rs.take_rate
             , rs.ncas
             , rs.transactions
             , rs.treasury_margin
             , case
                   when cc.origination_business_region_code = 'AMER' then 'AMER'
                   when cc.origination_business_region_code in ('EMEA', 'APAC') then 'E&A'
                   else 'Unmapped' END
        as region
        from reporting_staging rs
                 -- TODO: When reporting group changes, change this line to the new reporting group
                 left join (select distinct reporting_group, origination_business_region_code
                            from fpa.corridor_dimension
                            where origination_business_region_code is not null) cc
                           on rs.reporting_group = cc.reporting_group
        order by scenario, datevalue, reporting_group
