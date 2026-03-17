# ORBIS

AI-Powered Life Operating System

Product Requirements Document v2.2

| **Field**   | **Value**                     |
|-------------|-------------------------------|
| Version     | 2.2 (Platform Architecture)   |
| Date        | March 2026                    |
| Status      | Draft                         |
| Platform    | PWA (Web)                     |
| Backend     | Bun + TypeScript              |
| AI Provider | LLM-agnostic (Claude default) |

# 1. Vision & Overview

## 1.1 Product Vision

Orbis is an AI-powered life operating system. Not an app — a platform.

At its core is a universal entity graph where every piece of personal data lives as one entity with multiple aspects. Three OS-level components — Chat (AI command layer), Entity Browser (universal file manager), and Calendar (time visualization) — provide the foundation. On top, installable views act as specialized apps for specific domains (Budget charts, Fitness progress, Nutrition tracking).

Users choose which views to install, can create their own, and — in the future — share them through a marketplace. The platform grows through its community, not just its core team.

## 1.2 The Platform Analogy

| **Orbis Concept** | **Platform Analogy**     | **What It Does**                                                           |
|-------------------|--------------------------|----------------------------------------------------------------------------|
| Entity Graph      | File system              | Universal data storage. Every piece of life data.                          |
| Chat + AI         | Terminal / command line  | Natural language interface. Can do anything. Always available.             |
| Entity Browser    | File manager             | Browse, filter, organize, edit any entity. Smart lists. Core OS component. |
| Aspect            | File type / capability   | Gives an entity meaning in a domain (schedule, financial, fitness...).     |
| View              | Specialized app          | Installable domain-specific visualization. Calendar, Budget, etc.          |
| View Package      | App bundle               | Aspect definition + view config + AI instructions. Installable unit.       |
| Hub Launcher      | Home screen / App drawer | Grid of installed views. User arranges and customizes.                     |
| Marketplace       | App Store                | Browse, install, rate view packages from community.                        |

## 1.3 Core Value Proposition

- Entity-Aspect model — one entity, multiple views, zero duplication
- Three-component Core OS — Chat (AI command layer) + Entity Browser (universal file manager with smart lists) + Calendar (time visualization)
- Dynamic aspect registry — built-in + user-created aspects, all first-class
- Installable views — specialized visualizations (Budget charts, Fitness progress). User chooses what they need.
- View packages — community-contributed views with aspects and AI instructions
- Cross-aspect intelligence — AI reasons across all domains simultaneously

## 1.4 Target User

MVP: personal dogfooding (single user). Future: technically savvy individuals aged 25–40 who actively manage multiple life domains and want a single, customizable system instead of 5–10 separate apps.

## 1.5 Success Metrics (MVP)

- Daily active usage for 30+ consecutive days
- 80%+ of data input through chat
- At least 3 cross-aspect queries per week with actionable results
- User installs at least 2 official views from the catalog (Budget, Fitness, Nutrition, Habits)

# 2. Data Architecture

Full specification: companion document "Orbis Data Model v3.1". Summary below.

## 2.1 Four-Layer Entity Model

Every entity has four data layers:

| **Layer**   | **What**                               | **Purpose**                                                                                          |
|-------------|----------------------------------------|------------------------------------------------------------------------------------------------------|
| Core        | title, emoji, timestamps               | Identity. Every entity has this.                                                                     |
| Body        | Markdown string with extensions          | Formatted text, inline entity references (`[[entity:uuid|text]]`), dynamic query blocks (`{{query:...}}`). On every entity. |
| Tags + Meta | Normalized tags + AI-extracted JSONB    | Proto-aspect layer. AI extracts key-value data from user input before formal structuring. Migrates to aspects later. |
| Aspects     | Structured data per schema             | Full structured data for views. Validated against aspect definition.                                 |

Body gives every entity Notion-like rich content as a markdown string with extensions: inline entity references (`[[entity:uuid|Build API]]` — clickable links) and dynamic query blocks (`{{query: tags=backend}}` — live-updating filtered lists). References are auto-extracted into a `body_refs` array for fast backlink queries. A project entity can embed a query showing all its active tasks; a task can reference its blockers inline. MVP: textarea + markdown preview. Future: Lexical rich editor.

Tags are normalized labels (AI converts any language to canonical English: \#еда → \#food). Meta is parsed key-value data that AI extracts from every input (amount: 500, currency: "RUB"). Together they act as "proto-aspects" — capturing meaning before formal structuring.

When an aspect is activated later, migration is precise: meta fields map directly to aspect fields, because AI uses consistent keys that match aspect schemas.

## 2.2 Aspect Registry with Namespaces

Aspects are records in aspect_definitions. Namespaced IDs prevent conflicts:

- **orbis/** — built-in: orbis/schedule, orbis/task, orbis/financial, etc.
- **user/** — user-created: user/sleep, user/garden
- **\<author\>/** — community packages: sleeplab/advanced-sleep

Each aspect definition includes: name, JSON schema, AI instructions, view config, tag_mappings (which tags suggest this aspect), and aggregations.

## 2.3 Progressive Aspect Activation

Built-in aspects have three states:

- **active:** AI auto-attaches. Core OS aspects (orbis/schedule, orbis/task) start here.
- **passive:** AI recognizes context, saves tags + meta, but asks before attaching the aspect. Other built-in aspects (orbis/financial, orbis/fitness, etc.) start here.
- **inactive:** Ignored completely. User explicitly disabled.

First confirmation or view installation → passive becomes active. Triggers retroactive migration: system finds all entities with matching tags, maps their meta to aspect fields, attaches the aspect. Result: installing Budget view after weeks of chat-only usage shows full expense history instantly.

## 2.4 Eight Built-in Aspects

| **Aspect**      | **Purpose**                   | **Key Tag Mappings**     |
|-----------------|-------------------------------|--------------------------|
| orbis/schedule  | Time, duration, recurrence    | schedule, event, meeting |
| orbis/task      | Status, priority, due date    | task, todo, deadline     |
| orbis/financial | Amount, direction, category   | expense, income, payment |
| orbis/fitness   | Workout, exercises, RPE       | workout, fitness, gym    |
| orbis/nutrition | Meals, calories, macros       | food, meal, calories     |
| orbis/habit     | Frequency, check-ins, streaks | habit, routine, streak   |
| orbis/note      | Content, attachments          | note, thought, idea      |
| orbis/goal      | Target, progress, milestones  | goal, target, objective  |

All 8 aspects are available from day one. Not all have dedicated views:

Aspects fall into three categories:

- **Domain aspects**: orbis/financial, orbis/fitness, orbis/nutrition, orbis/habit — life domains with dedicated installable views (Budget, Fitness, Nutrition, Habits)
- **System aspects**: orbis/schedule and orbis/task (handled by Core OS: Calendar and Entity Browser), orbis/note (filter marker for text content), orbis/goal (auto-tracking, Goals View in future)
- **View aspects** (future): per-entity layout data for specialized views (e.g., orbis/board for Miro-like canvas with x/y coordinates)

An aspect is any structured facet of an entity that needs typed schema, AI instructions, and per-entity JSONB storage. It is NOT limited to "life domains" — system concepts and view-specific layout data are equally valid aspects.

## 2.5 Relations

Flat entity table + typed relations: parent (tree hierarchy), blocks (dependencies), related_to (soft links), derived_from (AI-generated breakdowns).

# 3. View Architecture

This section defines how views work as the "app layer" of the Orbis platform.

## 3.1 Core Principle: Data Exists Before Views

A view is a lens, not a container. Data lives in the entity graph regardless of whether a view is installed. The AI creates entities with appropriate aspects from day one — even if the corresponding view isn’t installed yet.

Example: a user spends two weeks chatting with AI, logging expenses ("spent 340₽ on lunch", "paid 3500₽ for gym"). The AI creates entities with aspect:financial each time. When the user later installs the Budget view, it queries all entities with aspect:financial — and the full two-week expense history appears instantly, with charts, categories, and trends. As if the view had been there from the start.

This is a deliberate architectural advantage. It means:

- Users don’t need to install views upfront — they can start with just Chat and add views when they feel the need
- Installing a view is immediately rewarding — it’s not empty, it’s already full of data
- Uninstalling a view loses nothing — data stays in the graph, re-installing brings it all back
- AI can work with aspects even when no view exists for them — the data layer is independent of the UI layer

## 3.3 What Is a View?

A view is an installable interface that filters the entity graph by one or more aspects and renders the results in a domain-specific format. A view consists of:

- **Filter:** Which aspects must be present (e.g., Calendar = entities with schedule aspect).
- **Renderer:** How to display the data (timeline, list, chart, grid, kanban, etc.).
- **Interactions:** What actions the user can take (create, edit, complete, reorder, etc.).
- **Linked aspect(s):** Which aspect definition(s) this view requires. Installing a view that needs a custom aspect also installs that aspect.

## 3.4 View Tiers

| **Tier**  | **Type**                | **Description**                                                                                                                                                               |
|-----------|-------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Core OS   | System components       | Chat + Entity Browser + Calendar. Not views — OS-level components. Cannot be removed. Entity Browser natively understands orbis/task (smart lists, checkboxes, dependencies). |
| Official  | Built-in optional views | Budget, Fitness, Nutrition, Habits. Available in catalog. Rich dedicated UI. Goals and Kanban planned for future.                                                             |
| Custom    | User-created views      | Declarative view definitions (filter + renderer config). Generic UI. Created through AI or settings.                                                                          |
| Community | Marketplace views       | View packages shared by other users. Aspect definitions + AI instructions + view config.                                                                                      |

## 3.5 View Packages

A view package is the installable unit. It bundles everything needed for a new domain:

| **Component**        | **What It Contains**                                                        |
|----------------------|-----------------------------------------------------------------------------|
| Aspect definition(s) | Name, schema (fields + types), description, AI instructions, aggregations.  |
| View config          | Filter (which aspects), renderer type, sort/group/color settings, layout.   |
| AI prompt additions  | When to auto-attach aspects, cross-aspect reasoning rules, example queries. |
| Status strip metric  | Optional metric to show in the persistent status strip.                     |
| Icon + metadata      | Name, description, icon, category, author, version.                         |

Example: a "Sleep Tracker" view package contains:

- Aspect: sleep (fields: bedtime, wake_time, quality, duration_hours, notes)
- View: chart renderer showing quality over time + list of recent entries
- AI instructions: "Attach when user mentions sleeping. Cross-reference with fitness: poor sleep = suggest lighter workout"
- Status strip: avg sleep quality this week

## 3.6 View Lifecycle

### Installation

- User browses catalog (official views) or marketplace (community views)
- One tap to install. Aspect definition(s) added to their registry. View appears in Hub.
- AI immediately gains awareness of the new aspect through dynamic tool generation.
- Retroactive data: view instantly shows all existing entities that already have the linked aspect — no migration, no import. If the user has been logging expenses through chat for weeks, Budget view is immediately populated with full history.

### Usage

- View appears in Hub Launcher with icon and badge
- Opens as modal overlay (same as current architecture)
- Chat FAB available inside for quick commands
- Cross-aspect queries work automatically (AI knows about all installed aspects)

### Uninstallation

- User removes view from Hub. View config and aspect definition hidden.
- Entities that have the aspect are NOT deleted. Data is preserved.
- AI stops attaching the aspect to new entities.
- Re-installing restores the view. All historical data reappears.

## 3.7 Custom View Creation

### Path A: Through AI chat

User: "I want to start tracking my sleep"

AI: proposes aspect definition (fields, schema) + view config (chart, sorted by date). User confirms or adjusts. View package created and installed instantly.

### Path B: Through settings UI

Manual form: define aspect fields, choose renderer type, set sort/group/color, write AI instructions. Full control for power users.

### Path C: From marketplace (future)

Browse community-created packages. Preview, install, customize. Rate and review.

# 4. UX Architecture

## 4.1 Layered UI Model

The UI has a clear hierarchy with three OS-level components and installable views on top:

### Core OS (cannot be removed)

- **Chat:** The command layer. Always accessible. Text + voice input. Rich cards in AI responses. Can do anything: create entities, query data, install views, manage the system.
- **Entity Browser:** The file manager. Browse, filter, organize, and edit any entity. Smart Lists (Today, Inbox, Next, Upcoming). Hierarchy navigation. Entity detail screen with body editor, tags, relations. Natively understands orbis/task (checkboxes, priorities, dependencies) even though it’s not a Tasks-specific view.
- **Calendar:** Timeline visualization for entities with orbis/schedule. Pre-installed because time is universally relevant. Week/day/month views.

These three components form the minimum viable OS. A user with only Chat + Entity Browser + Calendar can manage tasks, take notes, track habits, and organize projects — all through the universal entity interface.

### Installable Layer

- **Status Strip:** Persistent mini-dashboard showing key metrics from installed views. Customizable.
- **Hub Launcher:** Grid of installed view icons with badges. "+" leads to catalog/marketplace.
- **View Modals:** Full-screen overlays for specialized views (Budget charts, Fitness progress, Nutrition macros). Chat FAB available inside.
- **Chat Overlay:** Half-screen chat inside any view. Commands update the view behind instantly.

## 4.2 Hub Launcher as App Drawer

The Hub shows installed views (not core components — Chat, Browser, and Calendar are always accessible through the main navigation):

- Installed views shown with icons, names, and live badges (e.g., "52%" on Budget, "12/30" on Habits)
- Long-press to reorder, hide, or uninstall
- "+" button opens the view catalog: official views available to install + link to marketplace
- Search across installed and available views
- Categories: Finance, Health, Lifestyle, Productivity, Custom

## 4.3 Onboarding

New user starts with Chat + Entity Browser + Calendar. No views are pre-installed — the core OS is sufficient to start. The AI proactively suggests installing views based on usage patterns:

*User: "I spent 2000 rubles on groceries"*

*AI: "Recorded! I see you’ve been logging expenses for a week (23 entries, 14,200₽ total). The Budget view would give you spending charts and category breakdowns — want to install it?"*

This is organic, non-pushy view discovery. The core OS already handles everything — views are a bonus, not a requirement.

### The Wow Moment

The most powerful onboarding moment: user installs a view after weeks of chat-only usage. All historical data appears instantly. Entity Browser already let them manage tasks, notes, expenses through the universal interface. Now Budget view adds charts, trends, and category breakdowns — filled with data from day one.

## 4.4 Entity Browser + orbis/task: Native Task Management

Entity Browser has special awareness of the orbis/task aspect. When an entity has orbis/task, Browser renders:

- Checkbox — tap to complete (status → done). Color indicates priority.
- Status badge — inbox/planned/in_progress/waiting shown as colored label
- Dependency indicators — lock icon if blocked, with blocker name
- Smart Lists — Today, Inbox, Next, Upcoming, Waiting — computed from orbis/task fields + relations

This means full task management works in Entity Browser without any installed view. Kanban board, Gantt chart, Eisenhower matrix — these are optional views for specialized visualization, not required for task management.

## 4.4 Rich Cards & Smart Suggestions

AI responses include structured cards (budget graphs, day plans, meal plans, progress charts, entity cards). Cards have action buttons linking to relevant views. Context-aware suggestion chips change by time of day, recent activity, pending items, and installed views.

# 5. System Architecture

## 5.1 Tech Stack

| **Layer**        | **Technology**              | **Rationale**                                          |
|------------------|-----------------------------|--------------------------------------------------------|
| Frontend         | Vite + React                | Fast builds, pure client-side PWA.                     |
| Styling          | Tailwind CSS                | Rapid UI, consistent tokens.                           |
| State Management | Zustand                     | Lightweight, IndexedDB as source of truth, hot cache.  |
| Local DB         | IndexedDB (via sync lib)    | Offline-first. Large storage.                          |
| Cloud DB         | Supabase (PostgreSQL)       | Hosted Postgres, auth, realtime, RLS.                  |
| Backend Runtime  | Bun + TypeScript            | Fast startup, native TS, built-in test/bundle.         |
| API Layer        | tRPC                        | End-to-end type-safety. Shared types client ↔ server.  |
| ORM              | Drizzle                     | Type-safe, SQL-like, excellent JSONB support.           |
| AI Layer         | LLM-agnostic abstraction    | Unified interface. Claude default.                     |
| Voice            | Whisper API (OpenAI)        | High-quality STT.                                      |
| Hosting          | Vercel (FE) + Railway (API) | Edge frontend + managed Bun backend.                   |
| Auth             | Supabase Auth               | Built-in, multi-user ready.                            |

## 5.2 Offline-First

- **Local:** Full entity graph + installed view/aspect definitions in IndexedDB.
- **Sync:** PostgreSQL as truth. Aspect-level conflict resolution (LWW per aspect key).
- **AI offline:** Full CRUD without AI. Queued requests on reconnect.

## 5.3 AI Orchestration

### LLM-Agnostic Abstraction

Unified LLMProvider interface. Swap models via config. Handles formatting, tool normalization, context management, cost tracking.

### Dynamic Tool Generation

On each AI request: load active aspect_definitions for the user → generate tool descriptions from each aspect’s schema + ai_instructions → pass to LLM. User creates a 'sleep' aspect → AI immediately understands it. No code deployment.

Token budget managed through tiered loading: core aspects always loaded; recently-used aspects loaded in full; others summarized in one line.

### AI Functions

| **Function**         | **What It Does**                          | **Scope**                       |
|----------------------|-------------------------------------------|---------------------------------|
| entity.create        | Create entity with any aspect combination | Dynamic                         |
| entity.update        | Update specific aspect fields             | Dynamic                         |
| entity.complete      | Mark task aspect done                     | task                            |
| entity.query         | Search by aspects + filters               | Dynamic                         |
| entity.link          | Create typed relation                     | Relations                       |
| schedule.find_free   | Find available time slots                 | schedule                        |
| financial.aggregate  | Spending/income aggregation               | financial                       |
| fitness.progress     | Exercise progression                      | fitness                         |
| nutrition.meal_plan  | Generate constrained plan                 | nutrition + financial + fitness |
| habit.check_in       | Record completion                         | habit                           |
| goal.status          | Compute progress from linked data         | goal + any                      |
| view.suggest_install | Recommend a view based on context         | Platform                        |

## 5.4 Native Migration Path

Orbis starts as a PWA but is architected for a future transition to a native mobile shell with WebView-based views. This section documents the design constraints that ensure a smooth migration.

### Architecture: Native Shell + WebView Views

The current modal-based view architecture maps directly to native:

- **Chat (Layer 0):** Becomes a native screen. Full access to native APIs (push notifications, background sync, voice input via native speech). Best possible performance for the primary surface.
- **Views (Layer 3):** Each view opens as an isolated WebView container inside the native shell. The same React code runs in the WebView as in the PWA — zero rewrite for existing views.
- **Hub Launcher (Layer 2):** Native UI for smooth, responsive app-drawer experience.
- **Status Strip (Layer 1):** Native UI for real-time metric updates and native widgets (iOS WidgetKit, Android Widgets).

### Platform Bridge API

Views need access to platform capabilities. To avoid rewriting views during native migration, a Platform Bridge abstraction is introduced from day one:

| **Capability**  | **PWA Implementation**   | **Native Implementation**                |
|-----------------|--------------------------|------------------------------------------|
| Notifications   | Web Push API             | APNs / FCM via native bridge             |
| Camera          | MediaDevices API         | Native camera via JS bridge              |
| Health data     | Not available            | HealthKit / Google Fit via bridge        |
| Geolocation     | Geolocation API          | Native GPS (better accuracy, background) |
| Haptics         | Vibration API (limited)  | Native haptic engine                     |
| Offline storage | IndexedDB                | IndexedDB in WebView (same)              |
| Background sync | Service Worker (limited) | Native background tasks                  |
| Biometric auth  | WebAuthn (limited)       | Face ID / fingerprint via bridge         |

The bridge exposes a unified API: window.orbis.platform.requestCamera(), window.orbis.platform.getHealthData(), etc. In PWA, this calls Web APIs (or returns "not available"). In native, this calls the JS bridge to native code. Views call the same API regardless of environment.

### View Isolation: Hybrid Approach

Views have different trust levels, and the isolation strategy reflects this:

| **View Tier**                         | **PWA Runtime**              | **Native Runtime**               | **Trust Level**       |
|---------------------------------------|------------------------------|----------------------------------|-----------------------|
| Built-in (Budget, Fitness, Habits...) | React components in main app | Shared WebView or native rewrite | Full trust            |
| Custom (user-created)                 | React components in main app | Shared WebView                   | Full trust (own code) |
| Community (marketplace)               | Sandboxed iframe             | Isolated WebView                 | Untrusted             |

### Built-in & Custom Views: React Components

For MVP and all trusted views, the approach is simple: views are React components rendered directly in the main application. This gives:

- Maximum performance — no iframe overhead, shared React runtime, instant transitions
- Shared design system — Tailwind classes, theme variables, component library available directly
- Simple data access — views call hooks like useViewData(aspectFilter) and usePlatformBridge() which currently invoke functions directly in the same JS context
- Fast development — no build pipeline complexity, standard React development experience

These hooks are the key abstraction. Today useViewData() calls the data layer directly. In native, the same hook can be rewired to communicate via postMessage or JS bridge. View code stays identical.

### Community Views: Sandboxed iframe

Marketplace views from other users run in a sandboxed iframe with strict isolation:

- Separate JavaScript context — no access to main app’s DOM, state, or variables
- Communication exclusively via postMessage — view sends structured requests ("query entities with aspect:sleep"), shell validates and responds
- Capability permissions in package manifest — declares which Platform Bridge features the view needs (e.g., camera: true, notifications: false). Shell enforces.
- Aspect-scoped data access — iframe view can only query entities that have its declared linked aspect. Cannot access unrelated data.
- CSP (Content Security Policy) restricts network access, inline scripts, and external resources

The iframe loads a lightweight shell (orbis-view-runtime.js) that provides the same useViewData() and usePlatformBridge() hooks, but implemented over postMessage. Community view developers code against the same API as built-in views — the isolation is transparent.

### Platform Bridge SDK

A small SDK (orbis-view-sdk) provides the standard interface for all views regardless of runtime:

- **useViewData(filter):** Query entities by aspect. In main app: direct call. In iframe: postMessage. In native WebView: JS bridge.
- **usePlatformBridge():** Access platform capabilities (camera, notifications, health data). Same abstraction across all environments.
- **useEntity(id):** Read/update a specific entity. Triggers re-render on changes.
- **useTheme():** Get current theme tokens (colors, fonts, spacing). Ensures visual consistency even in iframe.

Built-in views import the SDK but it resolves to direct calls (zero overhead). Community views import the same SDK but it resolves to postMessage layer. The API surface is identical.

### Migration Path Summary

| **Phase**       | **Built-in Views**        | **Community Views**          | **Communication**             |
|-----------------|---------------------------|------------------------------|-------------------------------|
| PWA (now)       | React components (direct) | iframe + postMessage         | SDK abstracts both            |
| Native (future) | Shared WebView or native  | Isolated WebView + JS bridge | Same SDK, different transport |

The key insight: iframe → WebView is a near-zero-effort migration. Both are isolated browser contexts with message-passing communication. The SDK ensures view code needs no changes.

# 6. AI Interaction Scenarios

## 6.1 Level 1 — Quick Input

- ***"Spent 340₽ on lunch"*** → entity.create(aspects: {financial: {...}, schedule: {...}})
- ***"Tomorrow 3pm call with Dima"*** → entity.create(aspects: {schedule: {...}, task: {...}})
- ***"Slept at 11, up at 7, quality 8"*** → entity.create(aspects: {sleep: {...}, schedule: {...}}) \[custom aspect\]

## 6.2 Level 2 — Contextual Query

- ***"What’s today?"*** → Day plan card from schedule + task aspects
- ***"How’s my sleep this week?"*** → Chart card from sleep aspect
- ***"Budget status"*** → Budget card from financial aspect

## 6.3 Level 3 — Cross-Aspect Orchestration

- ***"Plan my week"*** → Reads schedule + task + fitness + habit + sleep. Creates optimized daily plans.
- ***"Meal plan for 5000₽, training MWF"*** → Reads financial + fitness. Creates nutrition entities.
- ***"Bad sleep this week, adjust training?"*** → Reads sleep + fitness + schedule. Suggests lighter sessions.

## 6.4 Level 4 — Platform Actions

AI can suggest platform-level actions:

- **View discovery:** "You’ve been tracking expenses for a week. Want me to install the Budget view for charts and insights?"
- **Aspect creation:** "Sounds like you want to track your garden. Want me to create a Garden aspect with fields for plant, watered_at, and status?"
- **Cross-view insight:** "Your spending on food is 40% above last month, but your nutrition tracking shows you’re hitting your protein targets better. Worth the trade-off?"

# 7. Marketplace Vision

The marketplace is a future capability. This section documents the vision to ensure architecture supports it from day one.

## 7.1 What Gets Shared

View packages (not raw data). A package contains: aspect definitions, view configuration, AI instructions, status strip metrics, icon and metadata. It does NOT contain user data.

## 7.2 Package Categories

| **Category**     | **Example Packages**                                     | **Audience**          |
|------------------|----------------------------------------------------------|-----------------------|
| Productivity     | Pomodoro timer, OKRs, Weekly review                      | Knowledge workers     |
| Finance          | Investment tracker, Crypto portfolio, Tax helper         | Finance-focused users |
| Health & Fitness | Sleep tracker, Meditation log, Running plan, Supplements | Health-conscious      |
| Lifestyle        | Garden log, Pet care, Book tracker, Recipe collection    | Hobby-oriented        |
| Education        | Study planner, Language learning log, Spaced repetition  | Students, learners    |

## 7.3 Trust and Safety

View packages are declarative configurations (JSON), not executable code. This means:

- No arbitrary code execution — packages define data structure and UI layout, not logic
- Sandboxed by design — a view can only access entities with its linked aspect
- AI instructions are text prompts, not code — they guide AI behavior, not override it
- Review process: automated schema validation + community moderation for marketplace

Future consideration: if/when views need custom rendering logic (not just configuration), implement a sandboxed runtime (iframe with limited API access).

## 7.4 Revenue Model (Future)

- Free: all built-in views + unlimited custom views
- Marketplace: free and paid community packages
- Revenue share: platform takes X% of paid package sales
- Premium: verified/featured packages with guaranteed quality

# 8. Authentication & Multi-User

MVP: Supabase Auth, single account. user_id on every entity, aspect_definition, and view config from day one. Future: RLS, subscriptions, data import/export, package publishing.

# 9. Security & Privacy

- Encryption at rest and in transit
- AI context minimization — only relevant entities per request
- No third-party data sharing beyond LLM API
- Local-first: data on device, cloud sync user-controlled
- View packages are declarative (JSON), not executable code
- Community packages pass automated validation before publishing
- Future: E2E encryption option

# 10. Phased Roadmap

### Phase 1 — Foundation (Weeks 1–4)

Goal: working OS with core components and AI.

- Entity-Aspect data layer: Bun + tRPC + Drizzle + PostgreSQL + aspect_definitions
- 3 built-in aspects: schedule, task, financial
- Core OS: Chat (with LLM abstraction, Claude default) + Entity Browser (with Smart Lists, body editor, orbis/task native support) + Calendar
- Hub Launcher + official catalog: Budget (first installable view)
- PWA shell, auth

### Phase 2 — Full Platform (Weeks 5–8)

Goal: all built-in aspects + official views + custom creation.

- Remaining built-in aspects: fitness, nutrition, habit, note, goal
- Official views: Fitness, Nutrition, Habits (installable from catalog)
- orbis/note and orbis/goal function through Entity Browser (no dedicated views)
- Rich cards in Chat + smart suggestions + AI-driven view discovery
- Cross-aspect orchestration scenarios
- Custom aspect creation (AI-assisted + settings UI)
- Custom view creation with generic renderer
- View package export/import (JSON)
- Voice input (Whisper STT)
- IndexedDB + offline-first sync with aspect-level conflict resolution

### Phase 3 — Polish & Sharing (Weeks 9–12)

Goal: production quality and early sharing.

- Sync reliability, conflict UI
- View UI refinement (charts, forms, data viz)
- AI prompt optimization for complex scenarios
- Performance + PWA optimization
- Custom view aggregations and status strip integration
- Package sharing via link (pre-marketplace)

### Phase 4 — Multi-User + Marketplace (Future)

Goal: public product with ecosystem.

- Public registration + onboarding flow
- Subscription system (AI costs)
- Data import from popular apps (Todoist, YNAB, Strong, etc.)
- Goals View: dedicated dashboard with progress bars, milestones, trends (when goal volume justifies)
- Native mobile shell (iOS/Android) with WebView-based views
- Platform Bridge: native push notifications, HealthKit/Google Fit, biometric auth
- Native Chat screen + native Hub Launcher for best core UX
- Home screen widgets (iOS WidgetKit, Android Widgets) for status strip metrics
- View marketplace: browse, install, rate, publish
- Package moderation and quality assurance
- Revenue sharing for premium packages

# 11. Risks & Mitigations

| **Risk**                    | **Impact**                             | **Mitigation**                                                                  |
|-----------------------------|----------------------------------------|---------------------------------------------------------------------------------|
| Platform complexity         | Much harder than a simple app          | Phase 1 is just an app. Platform emerges incrementally.                         |
| Generic view quality        | Custom views feel inferior to built-in | Invest in good default renderers. 5 types cover 80%+ of cases.                  |
| AI tool overload            | LLM confused by too many aspects       | Tiered tool loading. Token budget management.                                   |
| View package trust          | Malicious or broken packages           | Declarative only (no code). Schema validation. Community review.                |
| Marketplace chicken-and-egg | No packages → no users → no packages   | Seed with 20+ official packages. Custom views work without marketplace.         |
| AI API cost                 | High per-user cost                     | Cache queries. Batch context. Cheaper models for simple intents.                |
| Data input friction         | User stops logging                     | AI lowers friction. Smart suggestions. Organic view discovery.                  |
| Native migration            | Views break in WebView context         | Platform Bridge abstraction from day one. View isolation enforced in PWA phase. |
| Scope creep                 | Never ships                            | Phase 1 = working app. Platform features phased strictly.                       |

# 12. Appendix

## 12.1 Related Documents

- Orbis Data Model v3.1 (orbis-data-model.docx) — entity schema, body spec, aspect definitions, tags, meta, queries
- Entity Browser Core Spec (orbis-entity-browser.docx) — smart lists, hierarchy, dependencies, body editor
- Calendar Core Spec (orbis-calendar.docx) — timeline views, color system, overlapping events
- View PRDs: Budget (orbis-budget.docx), Fitness (orbis-fitness.docx), Habits (orbis-habits.docx), Nutrition (orbis-nutrition.docx)
- Deferred: Goals View (future, orbis/goal aspect works through Entity Browser in MVP)

## 12.2 Glossary

- **Entity:** Universal data unit. ID + title + JSONB map of aspects.
- **Aspect:** Typed data block attached to an entity. Defined in aspect_definitions registry.
- **View:** Installable UI surface that filters entities by aspect and renders them.
- **View Package:** Installable unit: aspect definition(s) + view config + AI instructions.
- **Core OS:** Three system components: Chat + Entity Browser + Calendar. Cannot be removed.
- **Entity Browser:** Core OS file manager. Browse, filter, organize entities. Smart Lists. Body editor. Native orbis/task support (checkboxes, dependencies).
- **Official view:** Built-in optional view with specialized UI. MVP: Budget, Fitness, Nutrition, Habits. Future: Goals, Kanban. Installable from catalog.
- **Custom view:** User-created view with generic renderer.
- **Community view:** Shared via marketplace. Declarative configuration.
- **Hub Launcher:** App drawer showing installed views with badges.
- **Relation:** Typed link between entities (parent, blocks, related_to, derived_from).
- **LLM Provider:** Abstraction for AI model switching.
