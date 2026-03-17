# ORBIS

### Budget View

Installable View — Detailed Specification

| **Field**     | **Value**                           |
|---------------|-------------------------------------|
| View ID       | orbis-budget                        |
| Linked Aspect | orbis/financial                     |
| Tier          | Official (installable from catalog) |
| Version       | 1.0                                 |
| Date          | March 2026                          |
| Parent Doc    | Orbis PRD v2.2                      |

# 1. Overview

## 1.1 Purpose

Budget View is the first installable view in the Orbis catalog. It provides financial visualization and envelope budgeting for entities with orbis/financial aspect: spending charts, category breakdowns, budget limits with progress bars, and transaction history.

Without Budget View installed, Orbis still tracks expenses through Chat + Entity Browser (AI creates entities with financial tags + meta, and orbis/financial aspect if active). Budget View adds the domain-specific visualizations that make financial data actionable.

## 1.2 Budgeting Philosophy: AI-Assisted Envelope

Orbis follows envelope budgeting (inspired by YNAB) with AI simplification:

- **Envelope principle:** Each month, income is distributed into category envelopes (food, transport, subscriptions...). Every expense draws from its envelope. When an envelope is empty — that category is spent.
- **Carryover:** Unspent amounts carry forward. Overspent amounts carry as debt. January food budget: 25000₽, spent 22000₽ → February starts with 28000₽ (25000 + 3000 surplus).
- **AI assistance:** AI proposes budget allocations based on past spending patterns. User confirms or adjusts. No manual spreadsheet work.
- **Cross-aspect intelligence:** AI knows your training schedule (fitness), meal plans (nutrition), and upcoming purchases (tasks). It can predict spending and warn about budget pressure.

## 1.3 What Budget View Shows That Entity Browser Cannot

| **Budget View**                                         | **Entity Browser**                                   |
|---------------------------------------------------------|------------------------------------------------------|
| Envelope progress bars (spent / limit per category)     | Raw list of financial entities                       |
| Spending charts (daily bar, weekly trend, category pie) | No charts                                            |
| Income vs expense summary with balance                  | Can filter by direction but no aggregation           |
| Carryover tracking month-to-month                       | No budget concept                                    |
| Weekly breakdown within monthly budget                  | No computed subdivisions                             |
| Recurring transaction forecasting                       | Shows recurring entities but no financial projection |

# 2. Data Model

## 2.1 orbis/financial Aspect Schema

| **Field**      | **Type** | **Required** | **Description**                                                                            |
|----------------|----------|--------------|--------------------------------------------------------------------------------------------|
| amount         | decimal  | YES          | Absolute amount. Always positive. Direction determines sign.                               |
| currency       | text     | NO           | ISO 4217 code (RUB, USD, EUR). Default from user settings.                                 |
| direction      | enum     | YES          | income \| expense. Determines how amount affects balance.                                  |
| category       | text     | YES          | User-defined: food, transport, housing, subscriptions, salary, freelance... AI normalizes. |
| recurring      | boolean  | NO           | True for subscriptions, rent, salary. Used for forecasting.                                |
| payment_method | text     | NO           | Cash, card, transfer. Optional for tracking.                                               |
| counterparty   | text     | NO           | Who: shop name, employer, service. AI extracts from context.                               |

Note: transactions are linked to budget envelopes via the `relations` table (relation_type: `parent`), not via an aspect field. This is consistent with how all entity-to-entity links work in Orbis.

## 2.2 Budget Envelope as Entity

A budget envelope is a regular entity with orbis/financial aspect. It defines the spending limit for a category in a period:

{

title: "Food budget — March 2026",

tags: \["budget", "food", "monthly"\],

aspects: {

"orbis/financial": {

amount: 25000,

currency: "RUB",

direction: "budget", // special direction for envelopes

category: "food"

}

},

meta: {

period_start: "2026-03-01",

period_end: "2026-03-31",

carryover: 3000, // surplus from previous month

effective_limit: 28000 // amount + carryover

}

}

Transaction entities are linked to the envelope via a `parent` relation in the relations table. Budget View computes spent = SUM(transactions linked to this envelope). Remaining = effective_limit - spent.

## 2.3 Category System

Categories are plain text strings normalized by AI. The system maintains a category registry per user:

| **Category**  | **Typical Tags**                          | **AI Recognition**        |
|---------------|-------------------------------------------|---------------------------|
| food          | expense, food, grocery, restaurant, lunch | "lunch 340₽" → food       |
| transport     | expense, transport, taxi, metro, fuel     | "taxi 500₽" → transport   |
| housing       | expense, housing, rent, utilities         | "rent" → housing          |
| subscriptions | expense, subscription, service            | "Spotify" → subscriptions |
| health        | expense, health, pharmacy, doctor         | "dentist" → health        |
| salary        | income, salary, work                      | "got paid" → salary       |

Users can create custom categories. AI learns from corrections: if user changes AI-assigned "food" to "entertainment" for a bar visit, AI remembers the pattern.

## 2.4 Recurring Transactions

Recurring financial entities use the same recurrence mechanism as tasks: template entity with orbis/schedule.recurrence field, generating instances via derived_from. Examples: monthly rent, weekly grocery budget, annual insurance.

Budget View uses recurring transactions for forecasting: "You have 5 subscriptions totaling 4200₽/month. These will auto-deduct from your subscriptions envelope."

# 3. Envelope Budgeting

## 3.1 Monthly Cycle

At the start of each month, the system creates (or AI proposes) envelope entities for each category:

- AI analyzes last 3 months of spending per category
- Proposes envelope amounts: "Based on your spending, I suggest: Food 25000₽, Transport 8000₽, Subscriptions 5000₽..."
- User confirms, adjusts, or lets AI auto-create
- Total envelope amounts should not exceed expected income (AI warns if they do)
- Envelopes carry over: surplus/deficit from previous month added to new envelope’s effective_limit

## 3.2 Carryover Logic

| **Scenario**                                   | **Behavior**                                                                                        |
|------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| Underspent: food budget 25000₽, spent 22000₽   | Surplus +3000₽ carries to next month. Next month effective_limit = new_budget + 3000.               |
| Overspent: transport budget 8000₽, spent 9500₽ | Deficit -1500₽ carries. Next month effective_limit = new_budget - 1500.                             |
| No budget set for category                     | Expenses tracked but no limit enforcement. Shown in "Unbudgeted" section.                           |
| New category appears mid-month                 | AI suggests creating an envelope. User can allocate from unassigned income.                         |
| Income exceeds envelope total                  | Remaining income shown as "Available to assign". Can be distributed to envelopes or left as buffer. |

## 3.3 Weekly Breakdown

Monthly envelopes are automatically divided into weekly budgets:

- Monthly limit / weeks remaining in month = weekly budget
- Dynamic: as the month progresses, weekly budget adjusts based on actual spending
- Example: Food 25000₽/month. Week 1: spent 7000₽ (over pace). Week 2 budget adjusts to (25000-7000)/3 = 6000₽ instead of 6250₽.
- AI insight: "You’re ahead of pace on food this week (4200₽ vs 6000₽ budget). Keep it up!" or "Food spending is 20% over weekly pace. Consider cooking at home this weekend."

## 3.4 Arbitrary Period Budgets

For non-monthly budgets (vacation, renovation, one-time project), use a budget envelope with custom period_start and period_end:

{

title: "Vacation budget — Turkey July 2026",

tags: \["budget", "vacation", "travel"\],

aspects: {

"orbis/financial": { amount: 80000, direction: "budget", category: "vacation" },

"orbis/goal": { target_value: 80000, current_value: 0, unit: "₽",

deadline: "2026-07-01" }

},

meta: { period_start: "2026-07-01", period_end: "2026-07-14" }

}

This entity is both a budget envelope AND a goal. orbis/goal tracks savings progress toward the vacation. Transactions tagged \#vacation link to this envelope. Budget View shows it as a special "project budget" card.

# 4. Budget View Representations

## 4.1 Overview Screen (Default)

The main screen shows the financial pulse at a glance:

- **Balance header:** Large number showing current balance (income - expenses this period). Green if positive, red if negative.
- **Income vs Expense:** Two numbers side by side: total income, total expenses for current month.
- **Envelope grid:** Cards for each category envelope. Each card shows: category name, spent / limit, progress bar (green → yellow → red as approaching limit), remaining amount, daily pace indicator.
- **"Available to assign":** If income exceeds total envelope allocations, shows unassigned amount. Tap to distribute.
- **Unbudgeted:** Expenses in categories without envelopes. Highlighted for attention.

## 4.2 Category Detail

Tap an envelope card to drill into category detail:

- Category header: name, spent / effective_limit, progress bar
- Carryover indicator: "+3000₽ from Feb" (green) or "-1500₽ from Feb" (red)
- Weekly breakdown: bar chart showing spending per week within this month
- Transaction list: all entities with orbis/financial in this category, sorted by date desc
- Recurring items: highlighted with repeat icon, showing next occurrence
- Trend: small sparkline showing this category over the last 3-6 months
- AI insight: contextual recommendation ("You usually spend less on food in the last week. On track to save 2000₽.")

## 4.3 Charts Screen

Dedicated visualization surface:

### Daily Spending Bar Chart

- X axis: days of current month. Y axis: total expense per day.
- Bars colored by category (stacked). Horizontal line showing daily average pace.
- Tap a bar to see that day’s transactions.

### Category Pie/Donut Chart

- Proportional breakdown of spending by category.
- Center: total spent. Segments: categories with amounts.
- Tap segment to drill into category detail.

### Weekly Trend

- Line chart: total weekly spending over the last 8-12 weeks.
- Smoothed trend line overlay showing direction (increasing/decreasing).
- Useful for long-term pattern recognition.

### Income vs Expense Over Time

- Dual bar chart: income (green) vs expense (red) per month over the last 6-12 months.
- Shows savings trend: gap between income and expense bars.

## 4.4 Transactions Screen

Full transaction list with filtering:

- All financial entities sorted by date desc
- Filter bar: category, direction (income/expense), date range, amount range, recurring only
- Search: by title, counterparty, tags
- Each row: date, title, amount (green for income, red for expense), category badge, recurring icon
- Tap to open entity detail (same as Entity Browser detail)
- Swipe actions: recategorize, mark as recurring, archive

## 4.5 Period Navigation

Budget View supports three period modes:

| **Period**      | **Navigation**                            | **Display**                                                     |
|-----------------|-------------------------------------------|-----------------------------------------------------------------|
| Month (default) | Left/right arrows. Month picker dropdown. | Monthly envelopes, monthly charts, weekly breakdown within.     |
| Week            | Left/right arrows. Week picker.           | Weekly pace within monthly envelope. Daily breakdown.           |
| Custom          | Date range picker. Named budgets.         | Project budgets (vacation, renovation). Shows as separate card. |

# 5. Recurring Transactions

## 5.1 Recognition

AI identifies recurring patterns automatically:

- Exact same counterparty + similar amount + monthly interval → AI suggests: "Looks like Netflix 799₽/month. Mark as recurring?"
- User can manually mark any transaction as recurring
- Recurring transactions create template entities with recurrence field
- Instances auto-generate for future months, pre-filling the budget

## 5.2 Forecasting

Budget View uses recurring transactions to project future spending:

- "5 subscriptions this month: 4200₽ total. Already deducted from your Subscriptions envelope."
- "Rent (45000₽) is due on the 1st. After rent, you’ll have 105000₽ for other categories."
- "Based on your recurring expenses (62000₽/month) and income (150000₽), you have 88000₽ for discretionary spending."

## 5.3 Upcoming Transactions

Budget View shows a "Coming Up" section:

- Next 7-14 days of expected recurring transactions
- Sorted by date. Amount and category shown.
- Tap to view/edit. Can skip or postpone individual instances.

# 6. AI Scenarios

## 6.1 Quick Transaction Input (Level 1)

- ***"Lunch 340₽"*** → entity.create(aspects: {orbis/financial: {amount: 340, direction: expense, category: food}, orbis/schedule: {start_at: now}}). Linked to food envelope via parent relation.
- ***"Got paid 150k"*** → entity with orbis/financial (amount: 150000, direction: income, category: salary). AI: "Income recorded. Want me to distribute across your envelopes?"
- ***"Taxi to airport 1200₽"*** → entity with financial (1200, expense, transport) + schedule (now) + tags \[travel, taxi\].
- ***"Netflix subscription 799"*** → entity with financial (799, expense, subscriptions, recurring: true).

## 6.2 Budget Queries (Level 2)

- ***"How much left for food this month?"*** → Computes: food envelope effective_limit - SUM(food expenses this month). Response: budget card with progress bar.
- ***"What did I spend on transport this week?"*** → SUM(transport expenses this week). Response: amount + comparison to weekly pace.
- ***"Show my subscriptions"*** → Query: financial entities where recurring = true. Response: list card with amounts and next billing date.
- ***"Am I on track this month?"*** → AI analyzes all envelopes vs spending pace. Response: summary card — green categories (under pace), yellow (close), red (over).

## 6.3 Budget Management (Level 2)

- ***"Set up budgets for March"*** → AI analyzes Feb spending, proposes envelopes with carryover applied. User confirms or adjusts each.
- ***"Move 3000₽ from transport to food"*** → AI updates both envelope entities: transport.amount -= 3000, food.amount += 3000.
- ***"I got a raise, income is now 180k"*** → AI updates salary recurring entity. Suggests redistributing the extra 30k across envelopes.

## 6.4 Cross-Aspect Intelligence (Level 3)

- ***"Plan a meal plan within budget"*** → AI reads: food envelope (remaining), fitness schedule (training days need more calories). Generates nutrition plan within financial constraint.
- ***"Can I afford a new gym membership?"*** → AI reads: current spending pace, income forecast, existing subscriptions. Response: "Your discretionary budget has 12000₽ remaining this month. A 3500₽ membership is feasible. Want me to add it as a recurring expense?"
- ***"How much am I spending on fitness overall?"*** → AI queries across aspects: gym membership (financial) + supplements (financial, tagged fitness) + sports equipment (financial, tagged fitness). Aggregates total.
- ***"I’m going on vacation July 1-14, budget 80k"*** → AI creates vacation envelope entity with custom period + orbis/goal for savings tracking. Suggests monthly savings plan to reach 80k by July.

## 6.5 Proactive AI Alerts

AI monitors spending and proactively alerts through Chat:

- "You’ve used 80% of your food budget with 12 days remaining. Daily pace is 650₽ — you might need to slow down."
- "Netflix price increased from 799₽ to 999₽. Your subscriptions budget is now 200₽ over limit. Adjust?"
- "You have 3 annual subscriptions renewing next month: total 12000₽. Make sure your budget accounts for this."
- "Great month! You saved 15000₽ more than last month. Main savings: transport (-3000₽) and food (-5000₽)."

# 7. UI Specification

## 7.1 Main Screen Layout

- **Header:** "Budget" title + period navigator (\< March 2026 \>) + view switcher (Overview \| Charts \| Transactions).
- **Balance card:** Large current balance number. Income and expense subtotals below. Period progress bar (how far into the month).
- **Envelope grid:** Scrollable grid of category cards. 2 columns on mobile, 3-4 on wider screens.
- **Coming Up:** Horizontal scroll of upcoming recurring transactions.
- **Quick add:** Bottom bar. Amount input + category selector. Designed for fastest possible expense entry.
- **Chat FAB:** Bottom-right. Opens chat overlay for AI budget commands.

## 7.2 Envelope Card

Each category envelope rendered as a card:

- Category name + emoji (top)
- Progress bar: green (0-60%), yellow (60-85%), red (85-100%), dark red (100%+). Width = spent/effective_limit.
- Numbers: "12,800 / 28,000₽" (spent / limit)
- Remaining: "15,200₽ left" or "-2,300₽ over" (red)
- Daily pace: small text "≈ 1,000₽/day remaining" computed from remaining / days_left
- Carryover indicator: small badge "+3k from Feb" (green) or "-1.5k from Feb" (red)
- Tap: opens category detail

## 7.3 Quick Add Bar

Optimized for the most common action — logging an expense:

- Amount input: numeric keypad. Type "340" and it shows "340₽"
- Category pills: last 4-5 used categories as quick-select buttons
- Title field: optional, auto-generated from context if empty ("Expense \#47")
- "Log" button: creates entity instantly. No full form needed.
- For income: toggle switch "Income" changes direction. Income entities get category selector too.

## 7.4 Transaction Row

- Date (left, compact: "12 Mar" or "Today")
- Title + counterparty (center)
- Amount (right): red for expense, green for income. Bold.
- Category badge (small colored pill below title)
- Recurring icon (↻) if recurring
- Tap: opens entity detail (full Entity Browser detail screen)

## 7.5 Chart Interactions

- All charts: tap a data point/segment to see underlying transactions
- Pie chart: tap segment → shows category transactions. Long-press → shows trend for that category.
- Bar chart: tap bar → shows that day’s transactions list
- Swipe on chart area: change period (previous/next month)

# 8. Data Flow

## 8.1 Loading Budget Data

-- Envelopes for current month

SELECT \* FROM entities

WHERE aspects ? 'orbis/financial'

AND aspects-\>'orbis/financial'-\>\>'direction' = 'budget'

AND (meta-\>\>'period_start')::date \<= CURRENT_DATE

AND (meta-\>\>'period_end')::date \>= CURRENT_DATE

-- Transactions for current month

SELECT \* FROM entities

WHERE aspects ? 'orbis/financial'

AND aspects-\>'orbis/financial'-\>\>'direction' IN ('income','expense')

AND created_at \>= date_trunc('month', CURRENT_DATE)

AND created_at \< date_trunc('month', CURRENT_DATE) + interval '1 month'

ORDER BY created_at DESC

## 8.2 Computing Envelope Status

-- For each envelope entity:

spent = SUM(amount) FROM transactions

WHERE linked to envelope via parent relation

OR (category = envelope.category AND period matches)

effective_limit = envelope.amount + envelope.meta.carryover

remaining = effective_limit - spent

pace = remaining / days_remaining_in_period

percentage = spent / effective_limit \* 100

## 8.3 Month Rollover

At the start of a new month (triggered by first app open or background job):

- For each category envelope from previous month: compute surplus/deficit
- Create new month’s envelope entities with carryover applied
- AI proposes adjustments: "Last month you overspent transport by 1500₽. Increase this month’s transport budget to 9500₽, or keep 8000₽ and absorb the deficit?"
- Recurring transaction instances generated for new month

## 8.4 Transaction Creation

- User says "coffee 350₽" or uses quick add bar
- Entity created with orbis/financial (amount: 350, direction: expense, category: food)
- System finds matching envelope for this category + current period
- Creates parent relation linking this transaction to the envelope entity
- Envelope status recomputed: spent increases, remaining decreases
- If spent \> 90% of limit: proactive AI alert

# 9. Cross-Aspect Behavior

## 9.1 Financial + Schedule

Entities with both orbis/financial and orbis/schedule appear in Budget AND Calendar:

- "Pay rent on the 1st" → scheduled recurring expense. Shows in Calendar as event block with ₽ badge. Shows in Budget as upcoming recurring.
- "Grocery shopping Saturday" → scheduled task + expense. Calendar shows time block. Budget pre-deducts from food envelope (optional).

## 9.2 Financial + Task

Entities with orbis/financial and orbis/task:

- "Buy new keyboard — 5000₽" → a planned purchase. Shows as task in Entity Browser (actionable). Shows in Budget as pending expense.
- Completing the task: AI asks "Mark the 5000₽ expense as spent?" If yes, expense recorded.
- Cancelled task: expense not recorded.

## 9.3 Financial + Fitness

- Gym membership as recurring expense: visible in both Budget and Fitness
- AI: "You’re paying 3500₽/month for the gym. You’ve been 8 times this month — that’s 437₽ per visit. Worth it!" (or "You’ve been once... consider pausing.")

## 9.4 Financial + Goal

- Savings goals: "Save 80000₽ for vacation by July"
- orbis/goal.current_value auto-updates: income - expenses each month
- Budget View shows savings progress alongside spending

# 10. Edge Cases

| **Scenario**                             | **Behavior**                                                                                                                             |
|------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| Transaction in category with no envelope | Appears in "Unbudgeted" section. AI suggests creating an envelope.                                                                       |
| Multiple currencies                      | MVP: single default currency. Multi-currency: future. Transactions in foreign currency stored as-is, conversion happens at display time. |
| Envelope overspent, user doesn’t adjust  | Negative carryover accumulates month-to-month. AI warns increasingly urgently.                                                           |
| Income arrives mid-month                 | "Available to assign" updates. AI suggests distributing to underfunded envelopes.                                                        |
| Refund received                          | Entity with direction: income, same category as original expense. Effectively returns money to envelope.                                 |
| Transaction recategorized                | Old envelope loses the amount, new envelope gains it. Both recompute. parent relation updated.                                                |
| Split transaction                        | Future: one payment, multiple categories (e.g., grocery trip = 80% food + 20% household). MVP: assign to primary category.               |
| Recurring amount changes                 | AI detects: "Netflix charged 999₽ instead of 799₽. Subscription price increased? Update recurring amount?"                               |
| First month (no history)                 | AI cannot suggest envelopes from history. Manual setup or AI asks about income and estimated expenses.                                   |
| Offline transaction logging              | Created locally. Envelope status recomputed locally. Synced on reconnect.                                                                |

# 11. Status Strip Metrics

| **Metric**             | **Computation**                     | **Display**                |
|------------------------|-------------------------------------|----------------------------|
| Remaining balance      | Income - expenses this month        | "82,600₽ left" (green/red) |
| Most-strained envelope | Envelope with highest spent/limit % | "Food: 85%" (yellow/red)   |

# 12. Integration with Other Components

| **Component**    | **How Budget Integrates**                                          | **Direction**                                 |
|------------------|--------------------------------------------------------------------|-----------------------------------------------|
| Entity Browser   | Financial entities visible in Browser. Same detail screen.         | Bidirectional.                                |
| Calendar         | Scheduled financial events show in both. Amount badge in Calendar. | Bidirectional.                                |
| Chat             | AI creates/queries financial data. Proactive budget alerts.        | Bidirectional.                                |
| Fitness (view)   | Gym costs tracked. Cost-per-visit computed.                        | Read: Budget reads fitness entities.          |
| Nutrition (view) | Meal plan costs. Grocery budget.                                   | Bidirectional: meal plan respects budget.     |
| Goals (view)     | Savings goals tracked against actual income-expense delta.         | Auto: goal.current_value from financial data. |

# 13. MVP vs Future

## 13.1 MVP

- Envelope budgeting with AI-assisted setup and carryover
- Category management with AI normalization
- Overview screen: balance, envelope grid, coming up
- Charts: daily bar, category pie, weekly trend, income vs expense
- Transaction list with filters and search
- Recurring transaction detection and forecasting
- Quick add bar for fast expense entry
- Weekly breakdown within monthly budget
- Arbitrary period budgets (vacation, project) via envelope + goal
- Cross-aspect: financial + schedule, financial + task
- Proactive AI alerts (approaching limit, pace warnings)
- Single currency (user default)

## 13.2 Future

- Multi-currency support with auto-conversion
- Split transactions (one payment, multiple categories)
- Bank import (CSV, OFX, or API)
- Receipt scanning (photo → AI extracts amount, counterparty, items)
- Spending predictions: AI forecasts month-end balance based on patterns
- Category-level trends over 6-12 months with anomaly detection
- Shared budgets (multi-user: family budget management)
- Investment tracking (portfolio view, separate aspect)
- Tax categorization and reporting
