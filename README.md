# BuyBuddy

**BuyBuddy** is a full-featured e-commerce backend built with **TypeScript**, **Express**, **Prisma**, and **Socket.IO**. It targets local brands and neighbourhood merchants — enabling them to onboard quickly, manage inventory, and sell to nearby customers with built-in real-time chat and notifications.

---

## 🚀 Highlights / Key Features

- ⚡ **TypeScript + Express** server with strict environment validation (Zod)

- 🔑 **Authentication & Authorization**

  - JWT access + refresh tokens
  - Email verification, password reset
  - Google OAuth

- 🛍️ **Product / Brand / Tag Management** with reviews & filtering

- 🛒 **Cart, Orders, Sub-Orders, Shipping flows**

- 💬 **Real-time Chat** via Socket.IO (gateway + services)

- 🔔 **Push Notifications** via Firebase (FCM)

- 📧 **Email Delivery** using pluggable SMTP/Gmail providers

- 📦 **Background Jobs & Queues** with Redis

- 🗄️ **Prisma ORM** with client extensions & helper selectors

- ☁️ **Cloudinary Integration** for media storage

- 🧩 **Modular Architecture** — `src/modules` & `src/services` separation

- 📊 **Monitoring Ready** with rate limiting, CORS, structured logging

- 🔎 **AI-powered Search** — integrated model-based search supporting _search by text description_ and _search by image_. The backend includes hooks for embeddings/vector search and image feature extraction so the storefront can return visual or semantic matches for uploaded photos or descriptive queries.

---

## 🌍 Local Brands Focus

This project is intentionally built for **local brands** — small-to-medium merchants, neighbourhood shops, and independent retailers who want to offer online ordering, in-person pickup, or local delivery. The platform includes workflows and UX considerations tailored to local commerce:

- Fast onboarding for a brand account and storefront creation.
- Lightweight product management (bulk-import, variants, inventory tracking).
- Order lifecycle that supports pickup slots and local delivery zones.
- Real-time communication between brand staff and customers (chat + push notifications).
- Simple analytics and order history for local sales tracking.

---

## 🔁 Brand & User Flows

Below are the main flows implemented end-to-end in the backend. They can be extended by frontends (web/mobile) or admin panels.

### Brand flow (merchant lifecycle)

1. **Sign up / Onboard** — Brand registers, verifies email, and completes profile (store name, address, opening hours, delivery zones).
2. **Configure** — Add payment settings, cloudinary credentials for media, and shipping preferences.
3. **Products** — Create categories, add products and variants, set inventory, upload images, add tags and discounts.
4. **Publish & Availability** — Publish products and define availability windows (e.g., "weekends only").
5. **Receive Orders** — Orders arrive via API or storefront; workers process payment and create `order` and possibly `sub-order` records.
6. **Fulfillment** — Accept/prepare orders, mark as ready for pickup or assign to a local delivery service. Update tracking or delivery status.
7. **Communication** — Chat with customers in real-time, send push notifications for status updates, or email receipts.
8. **Reporting** — View recent orders, revenue, and product-level stats (basic analytics)

### User flow (customer lifecycle)

1. **Browse / Search** — Find local brands, filter by category, tags, or delivery/pickup options.
2. **Product Details** — View product images, descriptions, options, reviews, and stock.
3. **Cart & Checkout** — Add items to cart, choose shipping/pickup, apply coupon codes, and pay.
4. **Order Confirmation** — Receive confirmation email and optional FCM push notification.
5. **Real-time Updates** — Track order status via notifications and chat with brand staff for changes.
6. **Receive & Rate** — Collect the order (pickup/delivery), mark as received, and leave a review.
7. **History & Re-order** — View past orders and reorder quickly from order history.

---

## 📂 Repository Layout

```
.
├── prisma/
│   ├── migrations/         # Database migration history
│   └── schema.prisma       # Main Prisma schema (models, datasource, generator)
├── src/
│   ├── config/             # Env validation, prisma client, logging, passport, configs
│   ├── jobs/               # Redis-backed background jobs & queues
│   ├── enums/              # Centralized TypeScript enums
│   ├── middlewares/        # Express middlewares (auth guards, error handling, validation)
│   ├── modules/            # Feature modules (auth, user, product, cart, order, chat, etc.)
│   ├── services/           # Adapters: email, firebase, socket, workers
│   ├── types/              # Shared TypeScript types & interfaces
│   ├── utils/              # Shared helpers & utility functions
│   ├── app.ts              # Express + Socket.IO setup and route registration
│   └── server.ts           # App bootstrap entrypoint
├── .env.example            # Environment variables template
├── .env
├── .gitignore              # Ignored files & folders
├── package-lock.json       # Locked dependency tree
├── package.json            # Project dependencies & scripts
├── README.md
└── tsconfig.json           # TypeScript compiler configuration
```

---

## System Design

![level 1](assets/system_design_1.jpeg?raw=true "system_design_1")
![level 2](assets/system_design_2.jpeg?raw=true "system_design_2")
![level 3](assets/system_design_3.jpeg?raw=true "system_design_3")

---
## ⚙️ Prerequisites

- **Node.js** v18+
- **PostgreSQL** (any Prisma-supported DB)
- **Redis** (for queues/sessions)
- **Cloudinary** account (for uploads)
- **Firebase** project & service account (for FCM)
- **SMTP provider** (Mailtrap, SendGrid, Gmail App Password, etc.)

---

## 🛠️ Quick Start (Development)

#### 1️⃣ Clone the repo

```sh
git clone https://github.com/SamerYaserr/BuyBuddy.git
cd BuyBuddy
```

#### 2️⃣ Setup `.env`

Use `.env.example` as a reference and create your `.env` file with required variables.

#### 3️⃣ Install dependencies

```sh
npm install
```

#### 4️⃣ Generate Prisma client & run migrations

```sh
npx prisma generate
npx prisma migrate dev --name init
```

#### 5️⃣ Start the server

- Development:

```sh
npm run dev
```

- Production build:

```sh
npm run build
npm run start
```

---

## 🌍 API Routes

The API is versioned under `/api/v1`.
Registered routers in `src/app.ts`:

### High-level overview:

- **Auth** → `/api/v1/auth` (register, login, refresh, reset, OAuth, etc.)
- **Users** → `/api/v1/users` (profile, update, list)
- **Brands** → `/api/v1/brands` (CRUD)
- **Products** → `/api/v1/products` (CRUD, filters, reviews)
- **Carts** → `/api/v1/carts` (add/remove items, update cart)
- **Orders & Sub-orders** → `/api/v1/orders`
- **Shipments** → `/api/v1/shipments`
- **Chats** → `/api/v1/chats` (real-time messaging)
- **Notifications** → `/api/v1/notifications`
- **Firebase FCM** → `/api/v1/fcm` (push notifications)
- **Search** → `/api/v1/search` (Ai search (image or text))

---

## 📌 Development Notes

- **Environment Validation**: strict Zod schema validation ensures missing vars fail fast.
- **Prisma Client Extensions**: auto-converts decimals into numbers for convenience.
- **Email Templates**: Handlebars templates stored in `src/services/email/templates`. Ensure they are copied on build.
- **Socket.IO**: Real-time chat is proxy-friendly; configure CORS properly in production.
- **Workers/Queues**: Redis-powered background jobs; workers should run separately in production.

---

## 🧪 Useful Commands

- Generate Prisma client → `npx prisma generate`
- Run migrations → `npx prisma migrate dev --name <name>`
- Reset DB (dangerous) → `npx prisma migrate reset`
- Dev server → `npm run dev`
- Build & start → `npm run build && npm run start`

---

## ✨ Next steps / Suggestions

- Add a lightweight admin dashboard for brands to manage orders and products.
- Add a merchant onboarding wizard (address validation, pickup slots, verification docs).
- Create webhook hooks for payment provider events and local delivery integrations.
- **AI & Conversational roadmap**: add an AI-powered **chatbot** (conversational assistant) in the next development phase to handle customer support, guided shopping, and order taking.
